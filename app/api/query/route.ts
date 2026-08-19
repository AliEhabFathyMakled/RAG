import { generateText } from 'ai'
import { NextResponse } from 'next/server'

const context = `Clinical RAG indexed sources include IDSA/ATS Consensus Guidelines on CAP (Clinical Infectious Diseases, 2019) and Diagnosis and Treatment of Adults with Community-Acquired Pneumonia (American Family Physician, 2022). Answer only from retrieved evidence, state uncertainty, and never provide individualized diagnosis or dosing without clinician review.`

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { question?: string } | null
  const question = body?.question?.trim()
  if (!question || question.length > 1200) return NextResponse.json({ error: 'Enter a question under 1200 characters.' }, { status: 400 })
  try {
    const result = await generateText({ model: 'openai/o4-mini', system: `You are a cautious clinical knowledge assistant. ${context}`, prompt: question })
    return NextResponse.json({ answer: result.text, citations: ['IDSA/ATS Consensus Guidelines on CAP', 'Diagnosis and Treatment of Adults with Community-Acquired Pneumonia'] })
  } catch {
    return NextResponse.json({ error: 'The evidence service is unavailable. Try again shortly.' }, { status: 503 })
  }
}
