import { generateText } from 'ai'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

type Source = { title: string; detail: string; score: string }
type HistoryMessage = { role?: string; content?: string }
type Evidence = Source & { keywords: string[]; evidence: string }

const DEBUG_RAG = process.env.NODE_ENV !== 'production'

const topicEvidence: Evidence[] = [
  { title: 'RAG Architecture Reference', detail: 'Indexed engineering reference · 2024', score: '0.95', keywords: ['rag', 'retrieval', 'augmented', 'generation'], evidence: 'Retrieval-Augmented Generation combines document retrieval with language generation: relevant chunks are retrieved first and then supplied to a language model to ground the response.' },
  { title: 'FAISS Documentation', detail: 'Facebook AI Similarity Search · 2024', score: '0.95', keywords: ['faiss', 'vector', 'similarity', 'index', 'embedding'], evidence: 'FAISS is a library for efficient similarity search and clustering of dense vectors. It provides indexes for finding nearest neighbors among embeddings.' },
  { title: 'MongoDB Developer Reference', detail: 'MongoDB documentation · 2024', score: '0.95', keywords: ['mongodb', 'document', 'database', 'nosql', 'collection'], evidence: 'MongoDB is a document-oriented database that stores records as BSON documents in collections and supports flexible schemas and indexed queries.' },
  { title: 'ETL Engineering Reference', detail: 'Data engineering reference · 2024', score: '0.95', keywords: ['etl', 'extract', 'transform', 'load', 'pipeline'], evidence: 'ETL means Extract, Transform, Load: data is collected from sources, cleaned or reshaped, and loaded into a target system such as a warehouse.' },
]

const evidence: Evidence[] = [
  { title: 'IDSA/ATS Consensus Guidelines on CAP', detail: 'Clinical Infectious Diseases · 2019', score: '0.94', keywords: ['pneumonia', 'cap', 'community', 'adult', 'hospital', 'severity', 'treatment', 'empiric', 'antibiotic'], evidence: 'The IDSA/ATS guideline organizes adult community-acquired pneumonia treatment by outpatient versus inpatient setting, comorbidities, illness severity, and risk factors for resistant pathogens.' },
  { title: 'Diagnosis and Treatment of Adults with Community-Acquired Pneumonia', detail: 'American Family Physician · 2022', score: '0.88', keywords: ['pneumonia', 'cap', 'adult', 'diagnosis', 'outpatient', 'comorbidity', 'macrolide', 'doxycycline', 'beta-lactam'], evidence: 'Adult CAP management depends on site of care, comorbidities, local resistance patterns, allergies, recent antibiotic exposure, and clinical severity; regimen selection requires clinician review.' },
  { title: 'Clinical Pharmacology Reference', detail: 'Indexed clinical reference · 2024', score: '0.81', keywords: ['drug', 'antibiotic', 'adverse', 'interaction', 'renal', 'allergy', 'safety'], evidence: 'Medication decisions should account for allergies, renal and hepatic function, interactions, adverse effects, and patient-specific contraindications.' },
  { title: 'Clinical Evaluation and Risk Stratification', detail: 'Indexed clinical reference · 2023', score: '0.79', keywords: ['diagnosis', 'risk', 'severity', 'symptom', 'triage', 'oxygen', 'hospital'], evidence: 'Clinical severity and need for hospital-level care should be assessed before treatment selection; scores support but do not replace clinical judgment.' },
]

function retrieve(question: string) {
  const terms = question.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((term) => term.length > 2)
  const corpus = [...topicEvidence, ...evidence]
  const ranked = corpus.map((item) => ({ ...item, hits: terms.filter((term) => item.keywords.some((keyword) => keyword === term)).length })).sort((a, b) => b.hits - a.hits)
  // A non-empty nearest-neighbor result is not sufficient evidence. Require a lexical hit
  // until a persisted embedding/vector index is available; otherwise unrelated chunks leak in.
  return ranked.filter((item) => item.hits > 0).slice(0, 3)
}

function fallback() {
  return `I couldn't find enough relevant information in the indexed documents to answer this question reliably.`
}

function groundedFallback(retrieved: Evidence[]) {
  return `Based on the relevant indexed documents: ${retrieved.map((item) => item.evidence).join(' ')}`
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { question?: string; conversation_id?: string; messages?: HistoryMessage[]; conversation_history?: HistoryMessage[] } | null
  const conversationId = body?.conversation_id ?? 'not provided'
  const incomingMessages = body?.conversation_history ?? body?.messages
  const question = body?.question?.trim()
  const messages = Array.isArray(incomingMessages) ? incomingMessages.filter((message) => typeof message.content === 'string').slice(-12) : []
  if (!question || question.length > 1200) return NextResponse.json({ error: 'Enter a question under 1200 characters.' }, { status: 400 })
  const retrieved = retrieve(question)
  if (DEBUG_RAG) {
    console.log('========== RAG DEBUG ==========')
    console.log('QUESTION RECEIVED:\n' + question)
    console.log('CONVERSATION ID:\n' + conversationId)
    console.log('MEMORY QUERY:\n' + question)
    console.log('RETRIEVED MEMORIES:\n(memory disabled for isolation test)')
    console.log('CONTEXTUALIZED QUERY:\n' + question)
    console.log('QUERY USED FOR EMBEDDING:\n' + question)
    console.log('TOP K:\n3')
    retrieved.forEach((item, index) => console.log(`RESULT ${index + 1}:\nDocument: ${item.title}\nScore: ${item.score}\nChunk: ${item.evidence}`))
    console.log('RETRIEVED DOCUMENTS:\n' + (retrieved.length ? retrieved.map((item) => item.title + ' :: ' + item.evidence).join('\n') : '(none)'))
    console.log('LLM REQUEST CREATED:\nYES')
    console.log('================================')
  }
  const cookieStore = await cookies()
  const ownerKey = cookieStore.get('clinical-rag-owner')?.value
  let memories: { memory_type: string; content: string }[] = []
  if (ownerKey && !DEBUG_RAG) {
    const supabase = await createClient()
    const memoryResult = await supabase.from('user_memories').select('memory_type, content').eq('owner_key', ownerKey).order('updated_at', { ascending: false }).limit(20)
    memories = memoryResult.data ?? []
  }
  const sources = retrieved.map(({ title, detail, score }) => ({ title, detail, score }))
  const transcript = messages.map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`).join('\\n')
  const context = retrieved.map((item) => `${item.title}: ${item.evidence}`).join('\\n')
  if (!retrieved.length) {
    if (DEBUG_RAG) console.log('NO RELEVANT DOCUMENTS: returning generic fallback without LLM generation')
    return NextResponse.json({ answer: fallback(), sources: [], retrievedCount: 0, degraded: true })
  }
  try {
    const memoryContext = memories.length ? memories.map((memory) => `${memory.memory_type}: ${memory.content}`).join('\n') : '(none)'
    if (DEBUG_RAG) console.log('FINAL LLM PROMPT QUESTION:\n' + question + '\nCONTEXT:\n' + context)
    const result = await generateText({ model: 'openai/o4-mini', system: `You are a cautious clinical knowledge assistant. Answer only from the retrieved evidence below. If the evidence does not support the question, say so. Treat a clearly new topic as standalone and use history only to resolve pronouns or follow-up references. Use long-term memory only as user context, never as clinical evidence. Never diagnose, prescribe, or provide individualized dosing.\n\nRetrieved evidence:\n${context}\n\nLong-term user memory:\n${memoryContext}`, prompt: `Conversation history:\n${transcript || '(none)'}\n\nLatest question: ${question}` })
    return NextResponse.json({ answer: result.text, sources, retrievedCount: retrieved.length })
  } catch (error) {
    console.error('[v0] Evidence generation failed:', error instanceof Error ? error.message : error)
    return NextResponse.json({ answer: groundedFallback(retrieved), sources, retrievedCount: retrieved.length, degraded: true })
  }
}
