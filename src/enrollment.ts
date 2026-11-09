import { Failure, hash, type ProjectConfig } from './types.ts';

/** Exact OAuth client IDs are identities. Never collapse them to a name/domain. */
export async function automaticMailboxId(project: string, userId: string, oauthClientId: string) {
  return 'gh_' + await hash(JSON.stringify([project, userId, oauthClientId]));
}
export function explicitMailbox(p: ProjectConfig, userId: string, oauthClientId: string) {
  const matches = Object.entries(p.clients).filter(([, c]) =>
    c.github?.userId === userId && c.github.oauthClientId === oauthClientId);
  if (matches.length > 1) throw new Failure(403, 'Ambiguous project mailbox grant');
  return matches[0]?.[0];
}
export function automaticEnrollmentLimit(p: ProjectConfig, userId: string, oauthClientId: string) {
  const policy = p.githubAutoEnroll;
  if (policy?.enabled !== true ||
    !/^[1-9][0-9]*$/.test(userId) || !oauthClientId || oauthClientId.length > 2048 ||
    (policy.blockedClientIds && (!Array.isArray(policy.blockedClientIds) || policy.blockedClientIds.includes(oauthClientId)))) return 0;
  const max = policy.maxClientsPerUser ?? 16;
  return Number.isInteger(max) && max >= 1 && max <= 32 ? max : 0;
}
