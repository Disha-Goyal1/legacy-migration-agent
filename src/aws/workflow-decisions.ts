export type CandidateRollbackDecision =
  | "already_restored"
  | "restore_previous"
  | "conflict";

export function decideCandidateRollback(
  currentCandidateKey: unknown,
  previousCandidateKey: string,
  candidateKey: string,
): CandidateRollbackDecision {
  if (currentCandidateKey === previousCandidateKey) {
    return "already_restored";
  }
  if (currentCandidateKey === candidateKey) {
    return "restore_previous";
  }
  return "conflict";
}
