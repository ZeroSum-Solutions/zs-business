import { randomUUID } from "node:crypto";

/**
 * A throwaway LOGIN a test plants on purpose to prove a guard refuses it. Cluster roles are
 * shared by every test database, so checks that scan all logins skip this exact name shape.
 */
export const plantedLoginPattern = "^zs_guard_[0-9a-f]{12}$";
export const plantedLoginName = () => `zs_guard_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
