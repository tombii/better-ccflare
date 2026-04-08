export type ComboFamily = 'opus' | 'sonnet' | 'haiku';

// Database row types (snake_case, INTEGER booleans — match SQLite storage)
export interface ComboRow {
	id: string;
	name: string;
	description: string | null;
	enabled: number; // 0 or 1
	created_at: number;
	updated_at: number;
}

export interface ComboSlotRow {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: number; // 0 or 1
}

export interface ComboFamilyAssignmentRow {
	family: string;
	combo_id: string | null;
	enabled: number; // 0 or 1
}

// Domain model types (camelCase, proper booleans)
export interface Combo {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	created_at: number;
	updated_at: number;
}

export interface ComboSlot {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: boolean;
}

export interface ComboFamilyAssignment {
	family: ComboFamily;
	combo_id: string | null;
	enabled: boolean;
}

// Extended type with slots populated
export interface ComboWithSlots extends Combo {
	slots: ComboSlot[];
}

// Converter functions (Row -> Domain)
export function toCombo(row: ComboRow): Combo {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		enabled: !!row.enabled,
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
	};
}

export function toComboSlot(row: ComboSlotRow): ComboSlot {
	return {
		id: row.id,
		combo_id: row.combo_id,
		account_id: row.account_id,
		model: row.model,
		priority: Number(row.priority),
		enabled: !!row.enabled,
	};
}

export function toComboFamilyAssignment(row: ComboFamilyAssignmentRow): ComboFamilyAssignment {
	return {
		family: row.family as ComboFamily,
		combo_id: row.combo_id,
		enabled: !!row.enabled,
	};
}
