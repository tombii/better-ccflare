import { Logger } from "@better-ccflare/logger";
import { BaseRepository } from "./base.repository";

const log = new Logger("ModelTranslationRepository");

export interface ModelTranslation {
	client_name: string;
	bedrock_model_id: string;
	is_default: boolean;
	auto_discovered: boolean;
}

export interface SimilarModel {
	client_name: string;
	similarity: number;
}

/**
 * Repository for managing model name translations between client-friendly names
 * and Bedrock model IDs.
 *
 * Enables users to request models using familiar Claude API names (e.g., "claude-3-5-sonnet")
 * while the proxy translates to Bedrock format (e.g., "us.anthropic.claude-3-5-sonnet-20241022-v2:0").
 */
export class ModelTranslationRepository extends BaseRepository<ModelTranslation> {
	/**
	 * Get Bedrock model ID for a client-facing model name
	 * @param clientName - The client-facing model name (e.g., "claude-3-5-sonnet")
	 * @returns Bedrock model ID if found, null otherwise
	 */
	getBedrockModelId(clientName: string): string | null {
		const result = this.get<{ bedrock_model_id: string }>(
			`SELECT bedrock_model_id FROM model_translations WHERE client_name = ?`,
			[clientName],
		);

		if (result) {
			log.debug(
				`Found translation: ${clientName} → ${result.bedrock_model_id}`,
			);
			return result.bedrock_model_id;
		}

		log.debug(`No translation found for: ${clientName}`);
		return null;
	}

	/**
	 * Add a new model translation mapping
	 * @param clientName - The client-facing model name
	 * @param bedrockModelId - The Bedrock model ID
	 * @param autoDiscovered - Whether this mapping was learned from passthrough (default: false)
	 */
	addTranslation(
		clientName: string,
		bedrockModelId: string,
		autoDiscovered: boolean = false,
	): void {
		const now = Date.now();
		const id = `model-trans-${now}-${Math.random().toString(36).substring(2, 9)}`;

		try {
			this.run(
				`INSERT OR IGNORE INTO model_translations (id, client_name, bedrock_model_id, is_default, auto_discovered, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					clientName,
					bedrockModelId,
					autoDiscovered ? 0 : 1,
					autoDiscovered ? 1 : 0,
					now,
					now,
				],
			);
			log.info(
				`Added model translation: ${clientName} → ${bedrockModelId}${autoDiscovered ? " (auto-discovered)" : ""}`,
			);
		} catch (error) {
			log.error(`Failed to add model translation: ${(error as Error).message}`);
		}
	}

	/**
	 * List all model translation mappings
	 * @returns Array of all translations ordered by client name
	 */
	listTranslations(): ModelTranslation[] {
		const rows = this.query<{
			client_name: string;
			bedrock_model_id: string;
			is_default: number;
			auto_discovered: number;
		}>(
			`SELECT client_name, bedrock_model_id, is_default, auto_discovered
			 FROM model_translations
			 ORDER BY client_name`,
		);

		return rows.map((row) => ({
			client_name: row.client_name,
			bedrock_model_id: row.bedrock_model_id,
			is_default: row.is_default === 1,
			auto_discovered: row.auto_discovered === 1,
		}));
	}

	/**
	 * Find similar model names for "Did you mean?" suggestions
	 * Uses simple substring matching for fuzzy search
	 * @param clientName - The model name to find suggestions for
	 * @param maxResults - Maximum number of results to return (default: 5)
	 * @returns Array of similar model names with similarity scores
	 */
	findSimilar(clientName: string, maxResults: number = 5): SimilarModel[] {
		const allTranslations = this.query<{ client_name: string }>(
			`SELECT client_name FROM model_translations ORDER BY client_name`,
		);

		const searchTerm = clientName.toLowerCase();
		const results: Array<{ client_name: string; similarity: number }> = [];

		for (const translation of allTranslations) {
			const targetName = translation.client_name.toLowerCase();

			// Exact match gets highest score
			if (targetName === searchTerm) {
				results.push({ client_name: translation.client_name, similarity: 1.0 });
				continue;
			}

			// Substring match
			if (targetName.includes(searchTerm) || searchTerm.includes(targetName)) {
				results.push({
					client_name: translation.client_name,
					similarity: 0.8,
				});
				continue;
			}

			// Simple Levenshtein-like distance for partial matches
			const distance = this._levenshteinDistance(searchTerm, targetName);
			const maxLength = Math.max(searchTerm.length, targetName.length);
			const similarity = 1 - distance / maxLength;

			// Only include reasonably similar matches (similarity >= 0.5)
			if (similarity >= 0.5) {
				results.push({
					client_name: translation.client_name,
					similarity,
				});
			}
		}

		// Sort by similarity (descending) and return top N
		return results
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, maxResults);
	}

	/**
	 * Calculate Levenshtein distance between two strings
	 * @param a - First string
	 * @param b - Second string
	 * @returns Number of edits required to transform a into b
	 */
	private _levenshteinDistance(a: string, b: string): number {
		const matrix: number[][] = [];

		// Initialize matrix
		for (let i = 0; i <= b.length; i++) {
			matrix[i] = [i];
		}
		for (let j = 0; j <= a.length; j++) {
			matrix[0][j] = j;
		}

		// Fill matrix
		for (let i = 1; i <= b.length; i++) {
			for (let j = 1; j <= a.length; j++) {
				if (b.charAt(i - 1) === a.charAt(j - 1)) {
					matrix[i][j] = matrix[i - 1][j - 1];
				} else {
					matrix[i][j] = Math.min(
						matrix[i - 1][j - 1] + 1, // substitution
						matrix[i][j - 1] + 1, // insertion
						matrix[i - 1][j] + 1, // deletion
					);
				}
			}
		}

		return matrix[b.length][a.length];
	}
}
