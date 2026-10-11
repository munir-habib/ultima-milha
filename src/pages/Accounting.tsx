import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { useOp } from '@/components/OpContext'
import { Button, Card, ErrorNote, PageTitle, Pill, Select, Sheet, Spinner } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap, useDriverOptions, useRouteOptions } from '@/lib/queries'
import { fetchAllPages, type Page } from '@/lib/paginate'
import { MOVEMENTS_CAP, MOVEMENT_COLS, MoveCancelled, applyFilters, changesLink, chunk, movePatch, needsRecord, noRecordExpected, oldestFirst, pendingQueue, relinkTarget, sums, type AccFilters, type MovePatch, type Movement, type Origin, type Period } from '@/lib/accounting'
import { exportAccounting } from '@/lib/export'
import { dateShort, eur, parseNum, todayISO } from '@/lib/format'
import type { Account, AccCtx } from './accounting/shared'
import Detail from './accounting/Detail'
import BatchBar from './accounting/Batch'
import MovementForm, { blankForm, formFrom, type MForm } from './accounting/Forms'
import { GroupedView, ListView, UnlinkedView } from './accounting/Views'
import Board, { MoveSheet } from './accounting/Board'
import { AccountsPanel, DistributionPanel, SettingsPanel } from './accounting/Panels'

type View = 'list' | 'validate' | 'unlinked' | 'grouped' | 'board' | 'distribution' | 'accounts' | 'settings'
const VIEWS: View[] = ['list', 'validate', 'unlinked', 'grouped', 'board', 'distribution', 'accounts', 'settings']
const PERIODS: Period[] = ['today', 'last7', 'thisMonth', 'lastMonth', 'all']
const ORIGINS: Origin[] = ['automatico', 'manual_rota', 'manual_geral']
const FILTERED_VIEWS: View[] = ['list', 'grouped', 'board']

/** Confirmacao pendente: 'relink' = alocacao ja propagada (linha antiga apagada); 'reopen' = vai ligar-se a um registo Validado. */
interface RelinkInfo { kind: 'relink' | 'reopen'; route: string; date: string; target?: { route: string; date: string }; ok: () => void; cancel: () => void }

export default function Accounting() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { roles, profile } = useAuth()
  const [params, setParams] = useSearchParams()
  const { ops, opId } = useOp()
  const { data: routeOpts = [] } = useRouteOptions()
  const { data: drivers = [] } = useDriverOptions()
  const isAdmin = roles.includes('super_admin')
  const canWrite = isAdmin || roles.includes('contabilista') // Auditor com acesso: so le

  const accounts = useQuery({ queryKey: ['bank_accounts'], queryFn: () => unwrap<Account[]>(supabase.from('bank_accounts').select('id,nome,banco,iban').is('deleted_at', null).order('nome')) })
  const movements = useQuery({
    queryKey: ['movements'],
    // por paginas: o PostgREST devolve no maximo 1000 linhas por pedido (um .limit(3000) sozinho truncava em silencio)
    queryFn: () =>
      fetchAllPages<Movement>(
        (from, to, wantCount) =>
          supabase.from('movements').select(MOVEMENT_COLS, wantCount ? { count: 'exact' } : undefined).is('deleted_at', null)
            .order('data', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to) as unknown as PromiseLike<Page<Movement>>,
        MOVEMENTS_CAP,
        undefined,
        (m) => m.id,
      ),
  })
  // limite de validacao dos automaticos: para explicar porque um movimento esta Pendente
  const settings = useQuery({
    queryKey: ['acc-threshold'],
    queryFn: () => unwrap<{ validation_threshold: number }[]>(supabase.from('accounting_settings').select('validation_threshold')),
  })
  const threshold = Number(settings.data?.[0]?.validation_threshold ?? 100)

  const paramView = params.get('view') as View | null
  const [view, setViewState] = useState<View>(paramView && VIEWS.includes(paramView) ? paramView : 'list')
  const [filters, setFilters] = useState<AccFilters>({ period: 'thisMonth', account: 'all', origin: 'all', category: 'all' })
  const [selected, setSelected] = useState<string | null>(null)
  const [form, setForm] = useState<MForm | null>(null)
  const [moving, setMoving] = useState<Movement | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set()) // selecao para acoes em lote
  // confirmacao antes de reclassificar (rota/operacao/data) uma alocacao JA propagada ao registo diario
  const [relink, setRelink] = useState<RelinkInfo | null>(null)
  const [actionError, setActionError] = useState<unknown>(null) // erros de acoes que nao passam por uma mutation (ex.: verificar o registo antes de mover)
  const [formError, setFormError] = useState<unknown>(null)
  const [movGone, setMovGone] = useState(false) // o ?mov= do aviso ja nao existe
  const boardVisited = useRef(false)

  const setView = (v: View) => {
    setViewState(v)
    setChecked(new Set())
    if (params.has('view')) { const p = new URLSearchParams(params); p.delete('view'); setParams(p, { replace: true }) }
    // o Quadro comeca sempre filtrado a hoje (o utilizador pode alargar)
    if (v === 'board' && !boardVisited.current) { boardVisited.current = true; setFilters((f) => ({ ...f, period: 'today' })) }
  }
  useEffect(() => {
    if (!paramView || !VIEWS.includes(paramView)) return
    setViewState(paramView)
    setChecked(new Set())
    if (paramView === 'board' && !boardVisited.current) { boardVisited.current = true; setFilters((f) => ({ ...f, period: 'today' })) }
  }, [paramView])

  const all = useMemo(() => movements.data?.rows ?? [], [movements.data])
  // ?mov=<id> (aviso do sino): abre o movimento e limpa o parametro
  const paramMov = params.get('mov')
  useEffect(() => {
    if (!paramMov || movements.isLoading) return
    if (all.some((m) => m.id === paramMov)) setSelected(paramMov)
    else setMovGone(true)
    const p = new URLSearchParams(params); p.delete('mov'); setParams(p, { replace: true })
  }, [paramMov, movements.isLoading, all]) // eslint-disable-line react-hooks/exhaustive-deps
  const today = todayISO()

  const routeScope = useMemo(() => routeOpts.filter((r) => opId === 'all' || r.operation_id === opId).map((r) => ({ id: r.id, nome: r.nome, operation_id: r.operation_id })), [routeOpts, opId])
  const ctx: AccCtx = useMemo(() => {
    const accName = (id: string | null) => (id ? accounts.data?.find((a) => a.id === id)?.nome ?? '—' : t('accounting.noAccount'))
    const opName = (id: string | null) => (id ? ops.find((o) => o.id === id)?.nome ?? '—' : t('accounting.other'))
    return {
      t, canWrite, isAdmin, accounts: accounts.data ?? [], ops, routes: routeScope, drivers, accName, opName, threshold,
      routeName: (id) => routeOpts.find((r) => r.id === id)?.nome ?? '—',
      label: (m) => m.descricao || (m.custo_tipo ? t(`accounting.autoCost.${m.custo_tipo}`) : t(`accounting.sub.${m.subcategoria}`)),
    }
  }, [t, canWrite, isAdmin, accounts.data, ops, routeScope, drivers, routeOpts, threshold])

  // fila "por validar", cartao "por validar" e Distribuicoes: com operacao selecionada incluem tambem o que nao tem operacao (general)
  const scoped = useMemo(() => applyFilters(all, { period: 'all', account: 'all', origin: 'all', category: 'all', opId, general: true }, today), [all, opId, today])
  const filtered = useMemo(() => applyFilters(all, { ...filters, opId }, today), [all, filters, opId, today])
  const queue = useMemo(() => pendingQueue(scoped), [scoped])
  const s = sums(view === 'validate' ? scoped : filtered)
  const pendingAll = sums(scoped) // cartao "por validar" e sempre global (independente do periodo)
  const truncated = movements.data?.truncated === true
  const noAccountCount = all.filter((m) => !m.deleted_at && m.conta_id === null).length
  const noAccountAuto = all.filter((m) => !m.deleted_at && m.conta_id === null && m.origem === 'automatico').length
  // alocacoes "por ligar" (mais antigas primeiro) e as marcadas "sem registo previsto"
  const unlinkedList = useMemo(() => oldestFirst(scoped.filter(needsRecord)), [scoped])
  const noRecordList = useMemo(() => oldestFirst(scoped.filter(noRecordExpected)), [scoped])
  // Distribuicoes: transferencias + as suas alocacoes + alocacoes sem transferencia ativa (o que o painel mostra)
  const distributionList = useMemo(() => {
    const transfers = scoped.filter((m) => m.subcategoria === 'transferencia_distribuicao' && !m.lancamento_referencia_id)
    const liveIds = new Set(scoped.map((m) => m.id))
    const transferIds = new Set(transfers.map((m) => m.id))
    const allocs = scoped.filter((m) => m.lancamento_referencia_id && (transferIds.has(m.lancamento_referencia_id) || !liveIds.has(m.lancamento_referencia_id)))
    return [...transfers, ...allocs]
  }, [scoped])
  // acoes em lote (so quem pode escrever): Lista, fila "Por validar" e "Por ligar"
  const batchVisible = view === 'list' ? filtered : view === 'validate' ? queue : view === 'unlinked' ? [...unlinkedList, ...noRecordList] : []
  const batchOn = canWrite && batchVisible.length > 0
  const selectedMovs = batchOn ? batchVisible.filter((m) => checked.has(m.id)) : []
  const batchFor = (list: Movement[]) => ({
    checked: new Set(selectedMovs.map((m) => m.id)),
    toggle: (id: string) => setChecked((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n }),
    toggleAll: () => setChecked((c) => { const n = new Set(c); const allSel = list.every((m) => n.has(m.id)); list.forEach((m) => (allSel ? n.delete(m.id) : n.add(m.id))); return n }),
  })
  const batchProps = batchOn && (view === 'list' || view === 'validate') ? batchFor(view === 'list' ? filtered : queue) : undefined
  // a exportacao segue o que se ve
  const exportList = view === 'validate' ? queue : view === 'unlinked' ? [...unlinkedList, ...noRecordList] : view === 'distribution' ? distributionList : view === 'accounts' ? all : filtered

  const invalidate = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['movements'] }), qc.invalidateQueries({ queryKey: ['movement-versions'] }), qc.invalidateQueries({ queryKey: ['movement-audit'] }), qc.invalidateQueries({ queryKey: ['records'] })])
  }

  const patch = useMutation({
    mutationFn: async ({ id, p }: { id: string; p: Partial<Movement> | MovePatch }) => {
      const { error } = await supabase.from('movements').update(p).eq('id', id)
      if (error) throw error
      await invalidate() // espera: o cartao so "assenta" depois de os dados novos chegarem
    },
  })
  // acoes em lote: um PATCH por bloco de ids (nao um por movimento); o servidor continua a decidir e a registar tudo
  const batchM = useMutation({
    mutationFn: async ({ ids, p }: { ids: string[]; p: Partial<Movement> }) => {
      for (const part of chunk(ids, 100)) {
        const { error } = await supabase.from('movements').update(p).in('id', part)
        if (error) throw error
      }
      await invalidate()
    },
    onSuccess: () => setChecked(new Set()),
  })
  const busy = patch.isPending || batchM.isPending

  const save = useMutation({
    mutationFn: async () => {
      const f = form!
      const body = {
        data: f.data, conta_id: f.conta_id, tipo: f.tipo, valor: parseNum(f.valor) ?? 0, operation_id: f.operation_id || null, subcategoria: f.subcategoria,
        pessoa_responsavel: f.pessoa.trim() || null, lancamento_referencia_id: f.ref || null, rota_id: f.operation_id ? f.rota_id || null : null,
        motorista_id: f.motorista_id || null, descricao: f.descricao.trim() || null,
      } // a origem (Manual-Rota/Geral) e decidida pelo servidor a partir da operacao
      const { error } = f.id ? await supabase.from('movements').update(body).eq('id', f.id) : await supabase.from('movements').insert({ ...body, tenant_id: profile!.tenant_id })
      if (error) throw error
      await invalidate()
    },
    onSuccess: () => setForm(null),
  })

  const confirmRelink = (info: Omit<RelinkInfo, 'ok' | 'cancel'>) => new Promise<void>((resolve, reject) => setRelink({ ...info, ok: () => { setRelink(null); resolve() }, cancel: () => { setRelink(null); reject(new MoveCancelled()) } }))
  // estado do registo diario de uma rota+data (o Contabilista nao le daily_records: RPC)
  const recordStatus = async (rota: string, data: string): Promise<string | null> => {
    const { data: s, error } = await supabase.rpc('record_status', { p_route: rota, p_data: data })
    if (error) throw error
    return (s as string | null) ?? null
  }
  /** Pede confirmacao quando a alteracao tem consequencias no registo diario (linha apagada / registo Validado que volta a Submetido). */
  const confirmIfNeeded = async (m: Movement | null, p: { rota_id?: string | null; operation_id?: string | null; data?: string; tipo?: 'debito' | 'credito' }, fresh?: { rota: string; data: string }) => {
    const propagated = m !== null && changesLink(m, p)
    const target = fresh ?? (m ? relinkTarget(m, p) : null)
    const targetValidated = target ? (await recordStatus(target.rota, target.data)) === 'validado' : false
    const tgt = target ? { route: ctx.routeName(target.rota), date: dateShort(target.data) } : undefined
    if (propagated && m) await confirmRelink({ kind: 'relink', route: ctx.routeName(m.rota_id), date: dateShort(m.data), target: targetValidated ? tgt : undefined })
    else if (targetValidated && tgt) await confirmRelink({ kind: 'reopen', route: tgt.route, date: tgt.date, target: tgt })
  }
  const guardedPatch = async (id: string, p: MovePatch | Partial<Movement>) => {
    const m = all.find((x) => x.id === id) ?? null
    await confirmIfNeeded(m, p)
    await patch.mutateAsync({ id, p })
  }
  const submitForm = async () => {
    const f = form
    if (!f) return
    const m = f.id ? all.find((x) => x.id === f.id) ?? null : null
    const body = { operation_id: f.operation_id || null, rota_id: f.operation_id ? f.rota_id || null : null, data: f.data, tipo: f.tipo }
    setFormError(null)
    try {
      if (m) await confirmIfNeeded(m, body)
      else if (f.ref && f.tipo === 'debito' && body.operation_id && body.rota_id) await confirmIfNeeded(null, body, { rota: body.rota_id, data: body.data }) // nova alocacao: liga-se logo a um registo Validado?
    } catch (e) {
      if (e instanceof MoveCancelled) return
      setFormError(e) // nunca engolir: o Contabilista tem de saber que nao gravou
      return
    }
    save.mutate()
  }

  const openNew = (p: Partial<MForm> = {}) => setForm(blankForm(accounts.data?.[0]?.id ?? '', p))
  const sel = all.find((m) => m.id === selected) ?? null
  const validate = (m: Movement) => patch.mutate({ id: m.id, p: { estado: 'confirmado' } })

  const exportXlsx = () =>
    void exportAccounting(
      t,
      exportList.map((m) => ({
        data: m.data,
        conta: ctx.accName(m.conta_id),
        tipo: t(`accounting.${m.tipo === 'credito' ? 'credit' : 'debit'}`),
        valor: (m.tipo === 'credito' ? 1 : -1) * Number(m.valor),
        categoria: ctx.opName(m.operation_id),
        rota: m.rota_id ? ctx.routeName(m.rota_id) : '',
        estado: t(`accounting.state.${m.estado}`),
        origem: t(m.origem === 'automatico' ? 'export.auto' : 'export.manual'),
        descricao: m.descricao ?? '',
        pessoa: m.pessoa_responsavel ?? '',
        subcategoria: t(`accounting.sub.${m.subcategoria}`),
      })),
      truncated ? { shown: movements.data?.rows.length ?? 0, total: movements.data?.total ?? '?' } : undefined, // ficheiro parcial diz que e parcial
    )

  const setF = (p: Partial<AccFilters>) => { setFilters((f) => ({ ...f, ...p })); setChecked(new Set()) }
  const card = 'flex flex-col justify-between'

  return (
    <div>
      <PageTitle
        action={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={view === 'settings' || exportList.length === 0} onClick={exportXlsx}>{t('export.excel')}</Button>
            {canWrite && (accounts.data?.length ?? 0) > 0 && <Button onClick={() => openNew()}>+ {t('accounting.newMovement')}</Button>}
          </div>
        }
      >
        {t('accounting.title')}
      </PageTitle>
      <ErrorNote error={movements.error ?? accounts.error ?? batchM.error ?? actionError} />
      {movGone && (
        <Card className="mb-4" data-testid="mov-gone">
          <p className="flex items-center justify-between gap-3 text-sm">{t('accounting.movGone')}<Button variant="ghost" className="min-h-8" onClick={() => setMovGone(false)}>{t('app.close')}</Button></p>
        </Card>
      )}
      {truncated && (
        <Card className="mb-4" data-testid="truncated-warning">
          <p className="text-sm" style={{ color: 'var(--pending)' }}>{t('accounting.truncated', { shown: movements.data?.rows.length ?? 0, total: movements.data?.total ?? '?' })}</p>
        </Card>
      )}

      {/* Totais oficiais: so Confirmado. O que esta por validar aparece SEMPRE a parte. */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="summary">
        <Card className={card} data-kpi="credits" data-value={s.credit}>
          <div className="text-sm text-muted">{t('accounting.summary.credits')}</div>
          <div className="text-2xl font-bold" style={{ color: 'var(--positive)' }}>{eur(s.credit, 0)}</div>
        </Card>
        <Card className={card} data-kpi="debits" data-value={s.debit}>
          <div className="text-sm text-muted">{t('accounting.summary.debits')}</div>
          <div className="text-2xl font-bold">{eur(s.debit, 0)}</div>
        </Card>
        <Card className={card} data-kpi="balance" data-value={s.net}>
          <div className="text-sm text-muted">{t('accounting.summary.balance')}</div>
          <div className="text-2xl font-bold" style={{ color: s.net >= 0 ? 'var(--positive)' : 'var(--negative)' }}>{eur(s.net, 0)}</div>
          <div className="text-xs text-muted">{t('accounting.summary.official')}</div>
        </Card>
        <button
          type="button"
          onClick={() => setView('validate')}
          data-testid="pending-card"
          data-kpi="pending"
          data-value={pendingAll.pendingAmount}
          className={clsx('rounded-card bg-card p-4 text-left', pendingAll.pendingCount > 0 ? 'pending-outline' : 'border border-border')}
        >
          <div className="text-sm text-muted">{t('accounting.view.validate')}</div>
          <div className="text-2xl font-bold" style={{ color: pendingAll.pendingCount > 0 ? 'var(--negative)' : undefined }}>{eur(pendingAll.pendingAmount, 0)}</div>
          <div className="text-xs text-muted">{t('accounting.summary.pendingCount', { count: pendingAll.pendingCount })}</div>
        </button>
      </div>

      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
        {VIEWS.map((v) => (
          <Pill key={v} active={view === v} onClick={() => setView(v)}>
            {t(`accounting.view.${v}`)}{v === 'validate' && queue.length > 0 ? ` (${queue.length})` : ''}{v === 'unlinked' && unlinkedList.length > 0 ? ` (${unlinkedList.length})` : ''}
          </Pill>
        ))}
      </div>

      {FILTERED_VIEWS.includes(view) && (
        <Card className="mb-4 space-y-3">
          <div className="flex flex-wrap gap-2" data-testid="period-filter">
            {PERIODS.map((p) => (<Pill key={p} active={filters.period === p} onClick={() => setF({ period: p })}>{t(`accounting.period.${p}`)}</Pill>))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill active={filters.account === 'all'} onClick={() => setF({ account: 'all' })}>{t('accounting.filter.allAccounts')}</Pill>
            {(accounts.data ?? []).map((a) => (<Pill key={a.id} active={filters.account === a.id} onClick={() => setF({ account: a.id })}>{a.nome}</Pill>))}
            {(noAccountCount > 0 || filters.account === 'none') && (
              <Pill active={filters.account === 'none'} onClick={() => setF({ account: 'none', period: 'all' })}>{t('accounting.noAccount')} ({noAccountCount})</Pill>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill active={filters.origin === 'all'} onClick={() => setF({ origin: 'all' })}>{t('app.all')}</Pill>
            {ORIGINS.map((o) => (<Pill key={o} active={filters.origin === o} onClick={() => setF({ origin: o })}>{t(`accounting.origin.${o}`)}</Pill>))}
            <Select value={filters.category} onChange={(e) => setF({ category: e.target.value })} aria-label={t('accounting.filter.category')} className="!min-h-9 !w-auto">
              <option value="all">{t('accounting.filter.allCategories')}</option>
              <option value="other">{t('accounting.other')}</option>
              {ops.map((o) => (<option key={o.id} value={o.id}>{o.nome}</option>))}
            </Select>
          </div>
        </Card>
      )}

      {movements.isLoading ? <Spinner /> : (
        <>
          {view === 'list' && <ListView key={`list-${filters.period}-${filters.account}-${filters.origin}-${filters.category}-${opId}`} list={filtered} ctx={ctx} busy={busy} onOpen={(m) => setSelected(m.id)} onValidate={validate} empty={t('app.empty')} batch={batchProps} />}
          {view === 'validate' && (
            <>
              <p className="mb-3 text-sm text-muted">{t('accounting.queue.hint')}</p>
              <ListView key={`queue-${opId}`} list={queue} ctx={ctx} busy={busy} onOpen={(m) => setSelected(m.id)} onValidate={validate} empty={t('accounting.queue.empty')} batch={batchProps} />
            </>
          )}
          {view === 'unlinked' && (
            <UnlinkedView todo={unlinkedList} flagged={noRecordList} ctx={ctx} busy={busy} onOpen={(m) => setSelected(m.id)} onValidate={validate} batchTodo={batchOn ? batchFor(unlinkedList) : undefined} batchFlagged={batchOn ? batchFor(noRecordList) : undefined} />
          )}
          {view === 'grouped' && <GroupedView list={filtered} ctx={ctx} busy={busy} onOpen={(m) => setSelected(m.id)} onValidate={validate} />}
          {view === 'board' && <Board list={filtered} ctx={ctx} apply={guardedPatch} onOpen={(m) => setSelected(m.id)} onMoveRequest={setMoving} />}
          {view === 'distribution' && (
            <DistributionPanel all={scoped} ctx={ctx} busy={busy} onOpen={(m) => setSelected(m.id)} onValidate={validate}
              onAddAllocation={(tr) => openNew({ ref: tr.id, pessoa: tr.pessoa_responsavel ?? '', data: tr.data, conta_id: tr.conta_id ?? accounts.data?.[0]?.id ?? '', subcategoria: 'outro' })} />
          )}
          {view === 'accounts' && <AccountsPanel all={all} ctx={ctx} onOpenNoAccount={() => { setF({ account: 'none', period: 'all' }); setView('list') }} />}
          {view === 'settings' && <SettingsPanel ctx={ctx} noAccountCount={noAccountAuto} onShowNoAccount={() => { setF({ account: 'none', period: 'all' }); setView('list') }} />}
        </>
      )}

      {batchOn && (
        <BatchBar
          selected={selectedMovs}
          ctx={ctx}
          busy={busy}
          onClear={() => setChecked(new Set())}
          onValidate={(ids) => batchM.mutate({ ids, p: { estado: 'confirmado' } })}
          onAssign={(ids, conta) => batchM.mutate({ ids, p: { conta_id: conta } })}
          onNoRecord={(ids, value) => batchM.mutate({ ids, p: { sem_registo_previsto: value } })}
        />
      )}

      <Detail
        m={sel}
        ctx={ctx}
        busy={busy}
        error={patch.error}
        onClose={() => { setSelected(null); patch.reset() }}
        onPatch={(id, p) => patch.mutate({ id, p })}
        onEdit={(m) => { setSelected(null); setForm(formFrom(m)) }}
        onMove={(m) => setMoving(m)}
        onDelete={(id, reason) => patch.mutate({ id, p: { deleted_at: new Date().toISOString(), motivo_apagado: reason } }, { onSuccess: () => setSelected(null) })}
      />
      <MoveSheet
        m={moving}
        ctx={ctx}
        onClose={() => setMoving(null)}
        onApply={(target) => { const m = moving; setMoving(null); const p = m && movePatch(m, target, routeScope); if (m && p) { setActionError(null); void guardedPatch(m.id, p).catch((e) => { if (!(e instanceof MoveCancelled)) setActionError(e) }) } }}
      />
      <MovementForm form={form} setForm={setForm} ctx={ctx} saving={save.isPending} error={formError ?? save.error} onSubmit={() => void submitForm()} />
      <Sheet open={relink !== null} onClose={() => relink?.cancel()} title={t('accounting.relink.title')}>
        {relink && (
          <div className="space-y-4" data-testid="relink-confirm">
            <p className="text-sm">{relink.kind === 'relink' ? t('accounting.relink.body', { route: relink.route, date: relink.date }) : t('accounting.relink.bodyValidated', { route: relink.route, date: relink.date })}</p>
            {relink.kind === 'relink' && relink.target && <p className="text-sm" data-relink-target-validated>{t('accounting.relink.targetValidated', relink.target)}</p>}
            <div className="flex gap-2">
              <Button className="flex-1" onClick={relink.ok} data-relink-confirm>{t('accounting.relink.confirm')}</Button>
              <Button variant="ghost" className="flex-1" onClick={relink.cancel} data-relink-cancel>{t('accounting.relink.cancel')}</Button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  )
}
