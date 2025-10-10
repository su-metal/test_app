// Seed stores.lat/lng around Toyohashi Station (within ~5km radius)
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm run seed:stores:locations
// Notes:
// - Requires service role key to update `public.stores`.
// - If `lat`/`lng` columns do not exist, run the SQL shown in errors.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

if (!url || !serviceKey) {
  console.error('[seed] Missing env: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  process.exit(1)
}

const sb = createClient(url, serviceKey)

// Toyohashi Station center (approx)
const CENTER = { lat: 34.7628, lng: 137.3833 }
const R_KM = 5 // radius in km

function randomPointWithinRadiusKm(center, rKm) {
  // Uniform over circle area
  const u = Math.random()
  const v = Math.random()
  const r = Math.sqrt(u) * rKm
  const theta = 2 * Math.PI * v

  const dxKm = r * Math.cos(theta)
  const dyKm = r * Math.sin(theta)

  const degLat = dyKm / 111.32
  const degLng = dxKm / (111.32 * Math.cos((center.lat * Math.PI) / 180))

  return { lat: center.lat + degLat, lng: center.lng + degLng }
}

async function main() {
  console.log('[seed] Fetching stores...')
  const { data: stores, error } = await sb.from('stores').select('id, name, lat, lng').limit(1000)
  if (error) {
    console.error('[seed] select error:', error.message)
    console.error('\nIf columns are missing, execute this SQL in Supabase SQL Editor:')
    console.error('  ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS lat double precision;')
    console.error('  ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS lng double precision;')
    console.error('  CREATE INDEX IF NOT EXISTS stores_lat_lng_idx ON public.stores (lat, lng);')
    process.exit(1)
  }

  const targets = (stores || []).filter((s) => s.lat == null || s.lng == null || (Number(s.lat) === 0 && Number(s.lng) === 0))
  if (targets.length === 0) {
    console.log('[seed] No stores need updates. Done.')
    return
  }

  console.log(`[seed] Updating ${targets.length} store(s) with random coordinates within ~${R_KM}km of Toyohashi Station`)

  let ok = 0, ng = 0
  for (const s of targets) {
    const p = randomPointWithinRadiusKm(CENTER, R_KM)
    const { error: uerr } = await sb.from('stores').update({ lat: p.lat, lng: p.lng }).eq('id', s.id)
    if (uerr) {
      ng++
      console.error(`[seed] update failed for id=${s.id}:`, uerr.message)
    } else {
      ok++
      console.log(`[seed] updated: ${s.name ?? s.id} -> (${p.lat.toFixed(5)}, ${p.lng.toFixed(5)})`)
    }
  }

  console.log(`[seed] Completed. success=${ok} failed=${ng}`)
}

main().catch((e) => {
  console.error('[seed] fatal:', e)
  process.exit(1)
})

