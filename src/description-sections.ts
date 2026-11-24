// The governed description contract: a Task/Story description carries exactly these top-level sections, in this order.
// Neutral module: governance.ts validates against it and workflow/engineering-review.ts builds templates from it.
export const SECTIONS = [
  "Purpose", "Context", "What to do", "Deliverables", "Acceptance / Evidence",
  "Do not", "Dependencies", "Documentation", "Execution Notes",
];
