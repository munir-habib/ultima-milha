import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { DriverOption, OperationOption, RouteOption, VehicleOption, ZoneOption } from './types'

/** Lanca o erro do PostgREST (para react-query) e devolve os dados. */
export async function unwrap<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data as T
}

export const useOperationOptions = () =>
  useQuery({ queryKey: ['operation_options'], queryFn: () => unwrap<OperationOption[]>(supabase.from('operation_options').select('*').order('nome')) })

export const useRouteOptions = () =>
  useQuery({ queryKey: ['route_options'], queryFn: () => unwrap<RouteOption[]>(supabase.from('route_options').select('*').order('nome')) })

export const useZoneOptions = () =>
  useQuery({ queryKey: ['zone_options'], queryFn: () => unwrap<ZoneOption[]>(supabase.from('zone_options').select('*').order('nome')) })

export const useVehicleOptions = () =>
  useQuery({ queryKey: ['vehicle_options'], queryFn: () => unwrap<VehicleOption[]>(supabase.from('vehicle_options').select('*').order('matricula')) })

export const useDriverOptions = () =>
  useQuery({ queryKey: ['driver_options'], queryFn: () => unwrap<DriverOption[]>(supabase.from('driver_options').select('*').order('nome')) })
