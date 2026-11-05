export type Classification = "fact"|"observation"|"hypothesis"|"belief"|"decision"|"memory"|"simulation"|"fictional_canon"|"unresolved_question";
export type SourceType = "founder_decision"|"user_interaction"|"agent_observation"|"external_research"|"system_event"|"simulation"|"generated_fiction";
export function validateInput(input: {source_type: SourceType; classification: Classification; content: string}) {
  if (!input.content || input.content.trim().length===0) throw new Error("VALIDATION: content empty");
  if (input.content.length>10000) throw new Error("VALIDATION: content too long");
  if (input.classification==="fictional_canon" && input.source_type!=="generated_fiction") throw new Error("FICTION_AS_FACT_REJECTED");
  return true;
}
