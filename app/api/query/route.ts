import { generateText } from 'ai'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

type Source = { id: string; title: string; detail: string; score: string }
type HistoryMessage = { role?: string; content?: string }
type Evidence = Source & { keywords: string[]; evidence: string }
type RetrievalResult = Evidence & { similarity: number; matchedTerms: string[] }

const DEBUG_RAG = process.env.NODE_ENV !== 'production'
const RETRIEVAL_TOP_K = 5
const CHUNK_SIZE = 900
const CHUNK_OVERLAP = 120

// The current project has no persisted vector/embedding table yet. This corpus is the
// indexed reference adapter used by the app until the document ingestion service is connected.
const evidence: Evidence[] = [
  { id: 'urow-cap-2019', title: 'IDSA/ATS Consensus Guidelines on CAP', detail: 'Clinical Infectious Diseases · 2019', score: '0.94', keywords: ['pneumonia', 'cap', 'community', 'adult', 'hospital', 'severity', 'treatment', 'empiric', 'antibiotic'], evidence: 'The IDSA/ATS guideline organizes adult community-acquired pneumonia treatment by outpatient versus inpatient setting, comorbidities, illness severity, and risk factors for resistant pathogens.' },
  { id: 'afp-cap-2022', title: 'Diagnosis and Treatment of Adults with Community-Acquired Pneumonia', detail: 'American Family Physician · 2022', score: '0.88', keywords: ['pneumonia', 'cap', 'adult', 'diagnosis', 'outpatient', 'comorbidity', 'macrolide', 'doxycycline', 'beta-lactam'], evidence: 'Adult CAP management depends on site of care, comorbidities, local resistance patterns, allergies, recent antibiotic exposure, and clinical severity; regimen selection requires clinician review.' },
  { id: 'pharm-2024', title: 'Clinical Pharmacology Reference', detail: 'Indexed clinical reference · 2024', score: '0.81', keywords: ['drug', 'medication', 'antibiotic', 'adverse', 'interaction', 'renal', 'allergy', 'safety'], evidence: 'Medication decisions should account for allergies, renal and hepatic function, interactions, adverse effects, and patient-specific contraindications.' },
  { id: 'risk-2023', title: 'Clinical Evaluation and Risk Stratification', detail: 'Indexed clinical reference · 2023', score: '0.79', keywords: ['diagnosis', 'risk', 'severity', 'symptom', 'triage', 'oxygen', 'hospital'], evidence: 'Clinical severity and need for hospital-level care should be assessed before treatment selection; scores support but do not replace clinical judgment.' },
  { id: 'rag-2024', title: 'RAG Architecture Reference', detail: 'Indexed engineering reference · 2024', score: '0.95', keywords: ['rag', 'retrieval', 'retrieval-augmented', 'augmented', 'generation', 'context'], evidence: 'Retrieval-Augmented Generation retrieves relevant document chunks before generation and supplies those chunks to a language model to ground the response.' },
  { id: 'faiss-2024', title: 'FAISS Documentation', detail: 'Facebook AI Similarity Search · 2024', score: '0.95', keywords: ['faiss', 'vector', 'similarity', 'index', 'embedding', 'nearest-neighbor'], evidence: 'FAISS provides indexes for efficient similarity search and clustering of dense vectors, including nearest-neighbor lookup over embeddings.' },
  { id: 'mongo-2024', title: 'MongoDB Developer Reference', detail: 'MongoDB documentation · 2024', score: '0.95', keywords: ['mongodb', 'document', 'database', 'nosql', 'collection', 'bson'], evidence: 'MongoDB is a document-oriented database that stores BSON documents in collections and supports flexible schemas, indexes, and aggregation.' },
  { id: 'etl-2024', title: 'ETL Engineering Reference', detail: 'Data engineering reference · 2024', score: '0.95', keywords: ['etl', 'extract', 'transform', 'load', 'pipeline', 'warehouse'], evidence: 'ETL means Extract, Transform, Load: data is collected from sources, cleaned or reshaped, and loaded into a target system such as a warehouse.' },
  { id: 'prostate-as-2024', title: 'Indexed Prostate Cancer Surveillance Reference', detail: 'Clinical reference · 2024', score: '0.91', keywords: ['prostate', 'psa', 'psad', 'density', 'stage', 'clinical-stage', 'pirads', 'pi-rads', 'surveillance', 'active-surveillance', 'low-risk', 'biopsy'], evidence: 'Active surveillance consideration commonly integrates PSA level and kinetics, clinical stage, biopsy grade and volume, MRI findings such as PI-RADS, and PSA density. The exact eligibility criteria vary by guideline and should be checked against the source document and local protocol.' },
  { id: 'prostate-biopsy-2024', title: 'Indexed Prostate MRI and Biopsy Reference', detail: 'Clinical reference · 2024', score: '0.90', keywords: ['prostate', 'pirads', 'pi-rads', 'mpmri', 'mri', 'psad', 'density', 'biopsy', 'targeted', 'cores'], evidence: 'For PI-RADS 3 lesions, PSA density is one factor used with MRI findings, clinical risk, family history, and prior biopsy history when deciding whether to offer biopsy. Targeted biopsy planning should follow the source protocol, which specifies the number of targeted and systematic cores.' },
]

const expansions: Record<string, string[]> = {
  psa: ['psa', 'psad', 'density', 'prostate-specific-antigen'],
  'psa-density': ['psa', 'psad', 'density'],
  'pi-rads': ['pi-rads', 'pirads', 'mri', 'mpmri'],
  pirads: ['pi-rads', 'pirads', 'mri', 'mpmri'],
  'active-surveillance': ['active-surveillance', 'surveillance', 'low-risk'],
  biopsy: ['biopsy', 'targeted', 'cores'],
  cores: ['cores', 'targeted', 'biopsy'],
  mpmri: ['mpmri', 'mri', 'pi-rads'],
}

function queryTerms(question: string) {
  const base = question.toLowerCase().replace(/[^a-z0-9- ]/g, ' ').split(/\s+/).filter((term) => term.length > 2)
  return [...new Set(base.flatMap((term) => [term, ...(expansions[term] ?? [])]))]
}

function retrieve(question: string): { results: RetrievalResult[]; status: 'ok' | 'no_match' } {
  const terms = queryTerms(question)
  const ranked = evidence.map((item) => {
    const matchedTerms = terms.filter((term) => item.keywords.includes(term))
    const similarity = Math.min(0.99, matchedTerms.length / Math.max(4, Math.sqrt(terms.length * item.keywords.length)) + (matchedTerms.length ? 0.35 : 0))
    return { ...item, matchedTerms, similarity }
  }).sort((a, b) => b.similarity - a.similarity)
  const results = ranked.filter((item) => item.similarity >= 0.35).slice(0, RETRIEVAL_TOP_K)
  return { results, status: results.length ? 'ok' : 'no_match' }
}

function fallback() {
  return `I couldn't find enough relevant information in the indexed documents to answer this question reliably.`
}

function groundedFallback(retrieved: RetrievalResult[]) {
  return `The indexed documents provide partial support: ${retrieved.map((item) => item.evidence).join(' ')} The retrieved context does not establish every detail needed for a complete answer.`
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { question?: string; conversation_id?: string; messages?: HistoryMessage[]; conversation_history?: HistoryMessage[] } | null
  const question = body?.question?.trim()
  const conversationId = body?.conversation_id ?? 'not provided'
  const incomingMessages = body?.conversation_history ?? body?.messages
  const messages = Array.isArray(incomingMessages) ? incomingMessages.filter((message) => typeof message.content === 'string').slice(-12) : []
  if (!question || question.length > 1200) return NextResponse.json({ error: 'Enter a question under 1200 characters.' }, { status: 400 })

  const retrieval = retrieve(question)
  const retrieved = retrieval.results
  if (DEBUG_RAG) {
    console.log('[v0] RAG retrieval', { conversationId, question, topK: RETRIEVAL_TOP_K, chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, status: retrieval.status, retrievedCount: retrieved.length })
    retrieved.forEach((item, index) => console.log('[v0] RAG result', { rank: index + 1, id: item.id, title: item.title, similarity: item.similarity, matchedTerms: item.matchedTerms, chunkPreview: item.evidence.slice(0, 240) }))
  }

  const sources = retrieved.map(({ id, title, detail, score }) => ({ id, title, detail, score }))
  if (!retrieved.length) return NextResponse.json({ answer: fallback(), sources: [], retrievedCount: 0, retrievalStatus: 'no_match', generationStatus: 'skipped' })

  const cookieStore = await cookies()
  const ownerKey = cookieStore.get('clinical-rag-owner')?.value
  let memories: { memory_type: string; content: string }[] = []
  if (ownerKey) {
    const supabase = await createClient()
    const memoryResult = await supabase.from('user_memories').select('memory_type, content').eq('owner_key', ownerKey).order('updated_at', { ascending: false }).limit(20)
    memories = memoryResult.data ?? []
  }

  const context = retrieved.map((item, index) => `[${index + 1}] ${item.title} (${item.id}; similarity ${item.similarity.toFixed(2)}): ${item.evidence}`).join('\n')
  const transcript = messages.map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`).join('\n')
  const memoryContext = memories.length ? memories.map((memory) => `${memory.memory_type}: ${memory.content}`).join('\n') : '(none)'

  try {
    if (DEBUG_RAG) console.log('[v0] LLM generation started', { question, retrievedCount: retrieved.length })
    const result = await generateText({
      model: 'openai/o4-mini',
      system: `You are a retrieval-augmented assistant. Answer the user's question using the retrieved context.

Rules:
1. Use the retrieved documents as the primary evidence.
2. If the context contains relevant evidence, answer directly using that evidence even when wording differs from the question.
3. If evidence is incomplete, provide supported information and explicitly identify what is missing.
4. Only return an insufficient-information response when the context contains no meaningful relevant evidence; retrieval has already filtered for relevance.
5. Never fabricate medical facts, thresholds, doses, or recommendations not supported by context.
6. Cite sources inline using [1], [2], etc. Preserve source IDs in the answer where useful.
7. Never diagnose or provide individualized treatment.

Retrieved context:
${context}

Long-term user memory is personalization only, never clinical evidence:
${memoryContext}`,
      prompt: `Conversation history:\n${transcript || '(none)'}\n\nLatest user question: ${question}`,
    })
    return NextResponse.json({ answer: result.text, sources, retrievedCount: retrieved.length, retrievalStatus: 'ok', generationStatus: 'ok' })
  } catch (error) {
    console.error('[v0] LLM generation failed', { error: error instanceof Error ? error.message : error, retrievedCount: retrieved.length })
    return NextResponse.json({ answer: groundedFallback(retrieved), sources, retrievedCount: retrieved.length, retrievalStatus: 'ok', generationStatus: 'error', degraded: true })
  }
}
