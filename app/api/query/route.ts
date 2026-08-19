import { generateText } from 'ai'
import { NextResponse } from 'next/server'

type Source = { title: string; detail: string; score: string }
type HistoryMessage = { role?: string; content?: string }
type Evidence = Source & { keywords: string[]; evidence: string }

const evidence: Evidence[] = [
  { title: 'IDSA/ATS Consensus Guidelines on CAP', detail: 'Clinical Infectious Diseases · 2019', score: '0.94', keywords: ['pneumonia', 'cap', 'community', 'adult', 'hospital', 'severity', 'treatment', 'empiric', 'antibiotic'], evidence: 'The IDSA/ATS guideline organizes adult community-acquired pneumonia treatment by outpatient versus inpatient setting, comorbidities, illness severity, and risk factors for resistant pathogens.' },
  { title: 'Diagnosis and Treatment of Adults with Community-Acquired Pneumonia', detail: 'American Family Physician · 2022', score: '0.88', keywords: ['pneumonia', 'cap', 'adult', 'diagnosis', 'outpatient', 'comorbidity', 'macrolide', 'doxycycline', 'beta-lactam'], evidence: 'Adult CAP management depends on site of care, comorbidities, local resistance patterns, allergies, recent antibiotic exposure, and clinical severity; regimen selection requires clinician review.' },
  { title: 'Clinical Pharmacology Reference', detail: 'Indexed clinical reference · 2024', score: '0.81', keywords: ['drug', 'antibiotic', 'adverse', 'interaction', 'renal', 'allergy', 'safety'], evidence: 'Medication decisions should account for allergies, renal and hepatic function, interactions, adverse effects, and patient-specific contraindications.' },
  { title: 'Clinical Evaluation and Risk Stratification', detail: 'Indexed clinical reference · 2023', score: '0.79', keywords: ['diagnosis', 'risk', 'severity', 'symptom', 'triage', 'oxygen', 'hospital'], evidence: 'Clinical severity and need for hospital-level care should be assessed before treatment selection; scores support but do not replace clinical judgment.' },
]

function retrieve(question: string) {
  const terms = question.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((term) => term.length > 2)
  return evidence.map((item) => ({ ...item, hits: terms.filter((term) => item.keywords.some((keyword) => keyword.includes(term) || term.includes(keyword))).length })).sort((a, b) => b.hits - a.hits).slice(0, 3)
}

function fallback(question: string, retrieved: Evidence[]) {
  const lower = question.toLowerCase()
  if (lower.includes('pneumonia') || lower.includes('cap')) return `For adult community-acquired pneumonia, treatment is selected according to outpatient versus inpatient care, comorbidities, illness severity, allergies, recent antibiotic exposure, and local resistance patterns. The indexed guidance supports using those factors to choose empiric therapy, but it does not provide an individualized regimen or dose for a specific patient. A clinician should confirm the diagnosis, severity, contraindications, and treatment plan.`
  if (lower.includes('drug') || lower.includes('medication') || lower.includes('antibiotic')) return `Medication decisions should be checked against allergies, renal and hepatic function, interactions, adverse effects, and patient-specific contraindications. The retrieved pharmacology reference supports a safety review before prescribing; it cannot determine an individual patient's regimen without clinical details.`
  if (lower.includes('diagnos') || lower.includes('triage') || lower.includes('severity')) return `Clinical evaluation should establish the working diagnosis and assess severity before treatment selection. The retrieved risk-stratification reference notes that scores can support triage, but they do not replace clinician judgment or bedside assessment.`
  return `I found limited directly matching evidence for “${question}”. The indexed clinical references support cautious, source-grounded review, but they do not provide enough evidence to answer this question reliably. Try asking about adult community-acquired pneumonia, treatment selection, medication safety, or clinical severity.`
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { question?: string; messages?: HistoryMessage[] } | null
  const question = body?.question?.trim()
  const messages = Array.isArray(body?.messages) ? body.messages.filter((message) => typeof message.content === 'string').slice(-12) : []
  if (!question || question.length > 1200) return NextResponse.json({ error: 'Enter a question under 1200 characters.' }, { status: 400 })
  const retrieved = retrieve(question)
  const sources = retrieved.map(({ title, detail, score }) => ({ title, detail, score }))
  const transcript = messages.map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`).join('\n')
  const context = retrieved.map((item) => `${item.title}: ${item.evidence}`).join('\n')
  try {
    const result = await generateText({ model: 'openai/o4-mini', system: `You are a cautious clinical knowledge assistant. Answer only from the retrieved evidence below. If the evidence does not support the question, say so. Treat a clearly new topic as standalone and use history only to resolve pronouns or follow-up references. Never diagnose, prescribe, or provide individualized dosing.\n\nRetrieved evidence:\n${context}`, prompt: `Conversation history:\n${transcript || '(none)'}\n\nLatest question: ${question}` })
    return NextResponse.json({ answer: result.text, sources, retrievedCount: retrieved.length })
  } catch (error) {
    console.error('[v0] Evidence generation failed:', error instanceof Error ? error.message : error)
    return NextResponse.json({ answer: fallback(question, retrieved), sources, retrievedCount: retrieved.length, degraded: true })
  }
}
