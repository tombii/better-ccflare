import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import {
	SearchProviderLabelTakenError,
	SearchProviderNotFoundError,
	SearchProviderRepository,
} from "../search-provider.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function makeRepo(db: Database): SearchProviderRepository {
	return new SearchProviderRepository(new BunSqlAdapter(db));
}

describe("SearchProviderRepository", () => {
	let db: Database;
	let repo: SearchProviderRepository;

	beforeEach(() => {
		db = makeDb();
		repo = makeRepo(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("create / get / list / delete", () => {
		it("creates a provider with defaults and reads it back by id", async () => {
			const created = await repo.create({
				provider: "tavily",
				label: "main-tavily",
				apiKey: "tvly-1234567890abcd",
			});

			expect(created.id).toBeTruthy();
			expect(created.provider).toBe("tavily");
			expect(created.label).toBe("main-tavily");
			expect(created.apiKey).toBe("tvly-1234567890abcd");
			expect(created.priority).toBe(0);
			expect(created.enabled).toBe(true);
			expect(created.maxResults).toBe(10);
			expect(created.extraConfig).toEqual({});
			expect(created.status).toBe("unknown");
			expect(created.statusMessage).toBeNull();
			expect(created.cooldownUntil).toBeNull();
			expect(created.createdAt).toBe(created.updatedAt);

			expect(await repo.findById(created.id)).toEqual(created);
			expect(await repo.findById("missing")).toBeNull();
		});

		it("stores extra config as JSON and round-trips it", async () => {
			const created = await repo.create({
				provider: "tavily",
				label: "with-config",
				apiKey: "k",
				extraConfig: { topic: "news", nested: { a: 1 } },
			});
			expect(created.extraConfig).toEqual({ topic: "news", nested: { a: 1 } });

			const raw = db
				.prepare(`SELECT extra_config FROM search_providers WHERE id = ?`)
				.get(created.id) as { extra_config: string };
			expect(JSON.parse(raw.extra_config)).toEqual({
				topic: "news",
				nested: { a: 1 },
			});
		});

		it("lists every provider ordered by priority ASC", async () => {
			await repo.create({ provider: "tavily", label: "c", priority: 20 });
			await repo.create({ provider: "exa", label: "a", priority: 0 });
			await repo.create({ provider: "serper", label: "b", priority: 10 });

			const all = await repo.findAll();
			expect(all.map((p) => p.label)).toEqual(["a", "b", "c"]);
		});

		it("hard-deletes a provider and reports whether a row was removed", async () => {
			const created = await repo.create({ provider: "tavily", label: "gone" });

			expect(await repo.delete(created.id)).toBe(true);
			expect(await repo.findById(created.id)).toBeNull();
			const count = db
				.prepare(`SELECT COUNT(*) AS n FROM search_providers`)
				.get() as { n: number };
			expect(count.n).toBe(0);

			expect(await repo.delete(created.id)).toBe(false);
		});
	});

	describe("update", () => {
		it("updates fields and moves updated_at", async () => {
			const created = await repo.create({
				provider: "tavily",
				label: "before",
				apiKey: "key-1",
			});
			// Ensure a distinct millisecond so the comparison is meaningful.
			await Bun.sleep(2);

			const updated = await repo.update(created.id, {
				label: "after",
				priority: 7,
				enabled: false,
				maxResults: 3,
				extraConfig: { topic: "general" },
			});

			expect(updated.label).toBe("after");
			expect(updated.priority).toBe(7);
			expect(updated.enabled).toBe(false);
			expect(updated.maxResults).toBe(3);
			expect(updated.extraConfig).toEqual({ topic: "general" });
			expect(updated.createdAt).toBe(created.createdAt);
			expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
			// apiKey omitted → kept
			expect(updated.apiKey).toBe("key-1");
		});

		it("sets updated_at even when no other field changes", async () => {
			const created = await repo.create({ provider: "tavily", label: "noop" });
			await Bun.sleep(2);
			const updated = await repo.update(created.id, {});
			expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
		});

		it("clears the key when apiKey is explicitly null", async () => {
			const created = await repo.create({
				provider: "tavily",
				label: "clear-key",
				apiKey: "abcdef123456",
			});
			const updated = await repo.update(created.id, { apiKey: null });
			expect(updated.apiKey).toBeNull();
		});

		it("throws SearchProviderNotFoundError for a missing id", async () => {
			await expect(repo.update("nope", { label: "x" })).rejects.toBeInstanceOf(
				SearchProviderNotFoundError,
			);
		});
	});

	describe("unique label", () => {
		it("rejects a duplicate label on create with a typed error", async () => {
			await repo.create({ provider: "tavily", label: "dup" });

			const attempt = repo.create({ provider: "exa", label: "dup" });
			await expect(attempt).rejects.toBeInstanceOf(
				SearchProviderLabelTakenError,
			);
			// Clean message, not a raw constraint exception.
			await expect(attempt).rejects.toThrow(/already exists/);
			expect((await repo.findAll()).length).toBe(1);
		});

		it("rejects renaming onto another provider's label", async () => {
			await repo.create({ provider: "tavily", label: "one" });
			const second = await repo.create({ provider: "exa", label: "two" });

			await expect(
				repo.update(second.id, { label: "one" }),
			).rejects.toBeInstanceOf(SearchProviderLabelTakenError);
			expect((await repo.findById(second.id))?.label).toBe("two");
		});

		it("allows re-saving a provider with its own unchanged label", async () => {
			const created = await repo.create({ provider: "tavily", label: "same" });
			const updated = await repo.update(created.id, {
				label: "same",
				priority: 1,
			});
			expect(updated.label).toBe("same");
			expect(updated.priority).toBe(1);
		});

		it("isLabelTaken ignores the row being edited", async () => {
			const created = await repo.create({ provider: "tavily", label: "mine" });
			expect(await repo.isLabelTaken("mine")).toBe(true);
			expect(await repo.isLabelTaken("mine", created.id)).toBe(false);
			expect(await repo.isLabelTaken("other")).toBe(false);
		});

		it("the database itself enforces uniqueness (held by the unique index)", async () => {
			await repo.create({ provider: "tavily", label: "raw" });
			expect(() =>
				db.run(
					`INSERT INTO search_providers (id, provider, label, created_at, updated_at)
					 VALUES ('x', 'tavily', 'raw', 1, 1)`,
				),
			).toThrow(/UNIQUE constraint failed/i);
		});
	});

	describe("key masking", () => {
		it("public reads expose only the last 4 chars", async () => {
			const created = await repo.create({
				provider: "tavily",
				label: "masked",
				apiKey: "tvly-secret-wxyz",
			});

			const list = await repo.findAllPublic();
			expect(list).toHaveLength(1);
			expect(list[0].apiKeyMasked).toBe("****wxyz");
			expect(list[0]).not.toHaveProperty("apiKey");
			expect(JSON.stringify(list)).not.toContain("tvly-secret-wxyz");

			const one = await repo.findByIdPublic(created.id);
			expect(one?.apiKeyMasked).toBe("****wxyz");
			expect(JSON.stringify(one)).not.toContain("tvly-secret-wxyz");
		});

		it("null key masks to null", async () => {
			const created = await repo.create({
				provider: "tavily",
				label: "no-key",
			});
			expect((await repo.findByIdPublic(created.id))?.apiKeyMasked).toBeNull();
		});
	});

	describe("listActiveByPriority", () => {
		it("returns only enabled providers, ordered by priority ASC", async () => {
			await repo.create({
				provider: "tavily",
				label: "p2",
				priority: 2,
				enabled: true,
			});
			await repo.create({
				provider: "exa",
				label: "disabled-first",
				priority: 0,
				enabled: false,
			});
			await repo.create({
				provider: "serper",
				label: "p1",
				priority: 1,
				enabled: true,
			});

			const active = await repo.listActiveByPriority();
			expect(active.map((p) => p.label)).toEqual(["p1", "p2"]);
		});

		it("excludes providers disabled by a later update", async () => {
			const created = await repo.create({
				provider: "tavily",
				label: "toggle",
				enabled: true,
			});
			expect(await repo.listActiveByPriority()).toHaveLength(1);

			await repo.update(created.id, { enabled: false });
			expect(await repo.listActiveByPriority()).toHaveLength(0);
			// Still listed for the admin view.
			expect(await repo.findAll()).toHaveLength(1);
		});
	});

	describe("updateHealth", () => {
		it("stores the probe result without touching updated_at", async () => {
			const created = await repo.create({ provider: "tavily", label: "probe" });
			const checkedAt = Date.now() + 1000;

			await repo.updateHealth(created.id, {
				status: "error",
				statusMessage: "401 unauthorized",
				cooldownUntil: checkedAt + 60_000,
				checkedAt,
			});

			const after = await repo.findById(created.id);
			expect(after?.status).toBe("error");
			expect(after?.statusMessage).toBe("401 unauthorized");
			expect(after?.statusCheckedAt).toBe(checkedAt);
			expect(after?.cooldownUntil).toBe(checkedAt + 60_000);
			expect(after?.updatedAt).toBe(created.updatedAt);
		});
	});
});
