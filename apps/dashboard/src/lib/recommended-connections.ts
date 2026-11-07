/**
 * industry-templates.md IT-8: the connections screen lists the applied template's recommended
 * connections first, in the template's order, then the rest in their own order. A recommended id
 * this environment does not offer is left out. Ordering only: nothing connects by itself.
 */
export function orderConnections<Id extends string>(offered: readonly Id[], recommended: readonly string[]): { id: Id; recommended: boolean }[] {
  const first = recommended.filter((id): id is Id => (offered as readonly string[]).includes(id));
  const unique = [...new Set(first)];
  return [
    ...unique.map((id) => ({ id, recommended: true })),
    ...offered.filter((id) => !unique.includes(id)).map((id) => ({ id, recommended: false })),
  ];
}
