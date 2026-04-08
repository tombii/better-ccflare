import { randomUUID } from "node:crypto";
import {
  type Combo,
  type ComboFamily,
  type ComboFamilyAssignment,
  type ComboFamilyAssignmentRow,
  type ComboRow,
  type ComboSlot,
  type ComboSlotRow,
  type ComboWithSlots,
  toCombo,
  toComboFamilyAssignment,
  toComboSlot,
} from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

export class ComboRepository extends BaseRepository<Combo> {
  // ── Combo CRUD ──────────────────────────────────────────────────────────

  async create(name: string, description?: string | null): Promise<Combo> {
    const id = randomUUID();
    const now = Date.now();
    await this.run(
      `INSERT INTO combos (id, name, description, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [id, name, description ?? null, now, now],
    );
    const row = await this.get<ComboRow>(
      `SELECT id, name, description, enabled, created_at, updated_at FROM combos WHERE id = ?`,
      [id],
    );
    if (!row) throw new Error(`Failed to create combo: ${name}`);
    return toCombo(row);
  }

  async findAll(): Promise<Combo[]> {
    const rows = await this.query<ComboRow>(
      `SELECT id, name, description, enabled, created_at, updated_at
       FROM combos ORDER BY created_at DESC`,
    );
    return rows.map(toCombo);
  }

  async findById(id: string): Promise<Combo | null> {
    const row = await this.get<ComboRow>(
      `SELECT id, name, description, enabled, created_at, updated_at FROM combos WHERE id = ?`,
      [id],
    );
    return row ? toCombo(row) : null;
  }

  async update(
    id: string,
    fields: Partial<{ name: string; description: string | null; enabled: boolean }>,
  ): Promise<Combo> {
    const now = Date.now();
    const setClauses: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];

    if (fields.name !== undefined) {
      setClauses.push("name = ?");
      params.push(fields.name);
    }
    if (Object.prototype.hasOwnProperty.call(fields, "description")) {
      setClauses.push("description = ?");
      params.push(fields.description ?? null);
    }
    if (fields.enabled !== undefined) {
      setClauses.push("enabled = ?");
      params.push(fields.enabled ? 1 : 0);
    }

    params.push(id);
    await this.run(
      `UPDATE combos SET ${setClauses.join(", ")} WHERE id = ?`,
      params,
    );

    const row = await this.get<ComboRow>(
      `SELECT id, name, description, enabled, created_at, updated_at FROM combos WHERE id = ?`,
      [id],
    );
    if (!row) throw new Error(`Combo not found after update: ${id}`);
    return toCombo(row);
  }

  async delete(id: string): Promise<void> {
    await this.run(`DELETE FROM combos WHERE id = ?`, [id]);
  }

  // ── Slot management ──────────────────────────────────────────────────────

  async addSlot(
    comboId: string,
    accountId: string,
    model: string,
    priority: number,
  ): Promise<ComboSlot> {
    const id = randomUUID();
    await this.run(
      `INSERT INTO combo_slots (id, combo_id, account_id, model, priority, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [id, comboId, accountId, model, priority],
    );
    const row = await this.get<ComboSlotRow>(
      `SELECT id, combo_id, account_id, model, priority, enabled FROM combo_slots WHERE id = ?`,
      [id],
    );
    if (!row) throw new Error(`Failed to create combo slot`);
    return toComboSlot(row);
  }

  async updateSlot(
    slotId: string,
    fields: Partial<{ model: string; priority: number; enabled: boolean }>,
  ): Promise<ComboSlot> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (fields.model !== undefined) {
      setClauses.push("model = ?");
      params.push(fields.model);
    }
    if (fields.priority !== undefined) {
      setClauses.push("priority = ?");
      params.push(fields.priority);
    }
    if (fields.enabled !== undefined) {
      setClauses.push("enabled = ?");
      params.push(fields.enabled ? 1 : 0);
    }

    if (setClauses.length > 0) {
      params.push(slotId);
      await this.run(
        `UPDATE combo_slots SET ${setClauses.join(", ")} WHERE id = ?`,
        params,
      );
    }

    const row = await this.get<ComboSlotRow>(
      `SELECT id, combo_id, account_id, model, priority, enabled FROM combo_slots WHERE id = ?`,
      [slotId],
    );
    if (!row) throw new Error(`Combo slot not found: ${slotId}`);
    return toComboSlot(row);
  }

  async removeSlot(slotId: string): Promise<void> {
    await this.run(`DELETE FROM combo_slots WHERE id = ?`, [slotId]);
  }

  async getSlots(comboId: string): Promise<ComboSlot[]> {
    const rows = await this.query<ComboSlotRow>(
      `SELECT id, combo_id, account_id, model, priority, enabled
       FROM combo_slots WHERE combo_id = ? ORDER BY priority ASC`,
      [comboId],
    );
    return rows.map(toComboSlot);
  }

  /**
   * Reorder slots by reassigning priority 0, 1, 2... matching the order of slotIds array.
   * slotIds must all belong to the same comboId.
   */
  async reorderSlots(comboId: string, slotIds: string[]): Promise<void> {
    for (let i = 0; i < slotIds.length; i++) {
      await this.run(
        `UPDATE combo_slots SET priority = ? WHERE id = ? AND combo_id = ?`,
        [i, slotIds[i], comboId],
      );
    }
  }

  // ── Family assignment ────────────────────────────────────────────────────

  /**
   * Upsert a family assignment. Pass comboId = null to unassign.
   */
  async setFamilyAssignment(
    family: ComboFamily,
    comboId: string | null,
    enabled: boolean,
  ): Promise<void> {
    await this.run(
      `INSERT INTO combo_family_assignments (family, combo_id, enabled)
       VALUES (?, ?, ?)
       ON CONFLICT(family) DO UPDATE SET combo_id = excluded.combo_id, enabled = excluded.enabled`,
      [family, comboId, enabled ? 1 : 0],
    );
  }

  async getFamilyAssignments(): Promise<ComboFamilyAssignment[]> {
    const rows = await this.query<ComboFamilyAssignmentRow>(
      `SELECT family, combo_id, enabled FROM combo_family_assignments`,
    );
    // Return stored rows; callers handle missing families as "no assignment"
    return rows.map(toComboFamilyAssignment);
  }

  /**
   * Returns ComboWithSlots only when:
   *   - The family has an assignment row with enabled = 1
   *   - The referenced combo has enabled = 1
   *   - Only enabled slots (slot.enabled = 1) are included, ordered by priority
   * Returns null if no active combo for the family.
   */
  async getActiveComboForFamily(
    family: ComboFamily,
  ): Promise<ComboWithSlots | null> {
    const assignment = await this.get<ComboFamilyAssignmentRow>(
      `SELECT family, combo_id, enabled FROM combo_family_assignments
       WHERE family = ? AND enabled = 1 AND combo_id IS NOT NULL`,
      [family],
    );
    if (!assignment || !assignment.combo_id) return null;

    const comboRow = await this.get<ComboRow>(
      `SELECT id, name, description, enabled, created_at, updated_at
       FROM combos WHERE id = ? AND enabled = 1`,
      [assignment.combo_id],
    );
    if (!comboRow) return null;

    const slotRows = await this.query<ComboSlotRow>(
      `SELECT id, combo_id, account_id, model, priority, enabled
       FROM combo_slots
       WHERE combo_id = ? AND enabled = 1
       ORDER BY priority ASC`,
      [comboRow.id],
    );

    const combo = toCombo(comboRow);
    return {
      ...combo,
      slots: slotRows.map(toComboSlot),
    };
  }
}
