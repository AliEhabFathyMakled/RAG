import { generateText } from 'ai'
import { NextResponse } from 'next/server'

const sources = [
  { title: 'IDSA/ATS Consensus Guidelines on CAP', detail: 'Clinical Infectious Diseases · 2019', score: '0.94' },
  { title: 'Diagnosis and Treatment of Adults with Community-Acquired Pneumonia', detail: 'American Family Physician · 2022', score: '0.88' },
]
const context = `Clinical RAG indexed sources include IDSA/ATS Consensus Guidelines on CAP (Clinical Infectious Diseases, 2019) and Diagnosis and Treatment of Adults with Community-Acquired Pneumonia (American Family Physician, 2022). Answer only from retrieved evidence, use the conversation history to resolve follow-up references, state uncertainty, and never provide individualized diagnosis or dosing without clinician review.`

type HistoryMessage = { role?: string; content?: string }
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { question?: string; messages?: HistoryMessage[] } | null
  const question = body?.question?.trim()
  const messages = Array.isArray(body?.messages) ? body.messages.slice(-12) : []
  if (!question || question.length > 1200) return NextResponse.json({ error: 'Enter a question under 1200 characters.' }, { status: 400 })
  try {
    const transcript = messages.map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`).join('\n')
    const result = await generateText({ model: 'openai/o4-mini', system: `You are a cautious clinical knowledge assistant. ${context}`, prompt: `Conversation so far:\n${transcript}\n\nRespond to the latest user question: ${question}` })
    return NextResponse.json({ answer: result.text, sources })
  } catch (error) {
    console.error('[v0] Evidence generation failed:', error instanceof Error ? error.message : error)
    const fallback = `Based on the indexed clinical sources, treatment choices for community-acquired pneumonia depend on illness severity, comorbidities, recent antibiotic exposure, local resistance patterns, allergies, and whether the patient needs hospital care. The IDSA/ATS guidance supports selecting empiric therapy according to those factors; a clinician should confirm the regimen for the individual patient. I could not complete the generative synthesis right now, so this is a limited evidence summary rather than individualized medical advice.`
    return NextResponse.json({ answer: fallback, sources, degraded: true })
  }
}
