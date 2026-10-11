import { sql } from '../lib.mjs'
const q = process.argv[2]; console.log(JSON.stringify(await sql(q), null, 1))
