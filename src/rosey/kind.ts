/**
 * kind.ts — what an item on Rosey's list is.
 *
 *  - `task`: an errand, chore, appointment or to-do ("book the dentist",
 *    "order a plumber", "buy a gift for X").
 *  - `grocery`: a product on a shopping list — food, household consumables
 *    ("milk", "bread", "toilet paper").
 *
 * Status (D4) is the same for both: a grocery item is bought (done) or not.
 * Dedup is per kind. The kind is written when an item is created and
 * afterwards only by hand, so a manual change always stands.
 */

export const ITEM_KINDS = ["task", "grocery"] as const;
export type RoseyItemKind = (typeof ITEM_KINDS)[number];

export function isItemKind(v: string): v is RoseyItemKind {
  return (ITEM_KINDS as readonly string[]).includes(v);
}
