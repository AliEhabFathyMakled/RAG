import { randomUUID } from 'crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const OWNER_COOKIE = 'clinical-rag-owner'
const allowedTypes = new Set(['preference', 'profile', 'instruction', 'fact'])

async function ownerKey() {
  const store = await cookies()
  const existing = store.get(OWNER_COOKIE)?.value
  if (existing) return { key: existing, response: null }
  const key = randomUUID()
  const response = NextResponse.json({ memories: [] })
  response.cookies.set(OWNER_COOKIE, key, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 365 })
  return { key, response }
}

export async function GET() {
  const { key, response } = await ownerKey()
  const supabase = await createClient()
  const { data, error } = await supabase.from('user_memories').select('id, memory_type, content, source, created_at, updated_at, last_used_at').eq('owner_key', key).order('updated_at', { ascending: false }).limit(50)
  if (error) return NextResponse.json({ error: 'Unable to load memories.' }, { status: 500 })
  if (response) { response.cookies.set(OWNER_COOKIE, key, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 365 }); return response }
  return NextResponse.json({ memories: data ?? [] })
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { content?: string; memoryType?: string } | null
  const content = body?.content?.trim()
  const memoryType = body?.memoryType ?? 'fact'
  if (!content || content.length > 500 || !allowedTypes.has(memoryType)) return NextResponse.json({ error: 'Memory content or type is invalid.' }, { status: 400 })
  const { key } = await ownerKey()
  const supabase = await createClient()
  const { data, error } = await supabase.from('user_memories').insert({ owner_key: key, memory_type: memoryType, content, source: 'conversation' }).select('id, memory_type, content, source, created_at, updated_at, last_used_at').single()
  if (error) return NextResponse.json({ error: 'Unable to save memory.' }, { status: 500 })
  const response = NextResponse.json({ memory: data }, { status: 201 })
  response.cookies.set(OWNER_COOKIE, key, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 365 })
  return response
}
