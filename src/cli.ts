#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { parseArgs } from "util"
import crypto from "crypto"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const db = new Database("./claude-accounts.db", { create: true })

// Initialize database
db.run(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    access_token TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used INTEGER,
    request_count INTEGER DEFAULT 0
  )
`)

db.run(`
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    account_used TEXT,
    status_code INTEGER,
    success BOOLEAN,
    error_message TEXT,
    response_time_ms INTEGER,
    failover_attempts INTEGER DEFAULT 0
  )
`)

interface Account {
  id: string
  name: string
  refresh_token: string
  access_token: string | null
  expires_at: number | null
  created_at: number
  last_used: number | null
  request_count: number
}

async function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url")
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url")
  return { verifier, challenge }
}

async function authorize(mode: "max" | "console") {
  const pkce = await generatePKCE()
  
  const url = new URL(
    `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`
  )
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", "https://console.anthropic.com/oauth/code/callback")
  url.searchParams.set("scope", "org:create_api_key user:profile user:inference")
  url.searchParams.set("code_challenge", pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", pkce.verifier)
  
  return {
    url: url.toString(),
    verifier: pkce.verifier,
  }
}

async function exchangeCode(code: string, verifier: string) {
  const splits = code.split("#")
  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  })
  
  if (!response.ok) {
    throw new Error(`Exchange failed: ${response.statusText}`)
  }
  
  const json = await response.json()
  return {
    refresh: json.refresh_token as string,
    access: json.access_token as string,
    expires: Date.now() + json.expires_in * 1000,
  }
}

async function addAccount(name: string, mode: "max" | "console" = "console") {
  // Check if account name already exists
  const existing = db.query<Account, [string]>(`SELECT * FROM accounts WHERE name = ?`).get(name)
  if (existing) {
    console.error(`❌ Account with name "${name}" already exists`)
    process.exit(1)
  }

  const { url, verifier } = await authorize(mode)
  
  console.log("\n🔗 Open this URL in your browser to authorize:")
  console.log(url)
  console.log("\n📋 After authorization, you'll get a code. Paste it here:")
  
  const code = prompt("Authorization code: ")
  if (!code) {
    console.error("❌ No code provided")
    process.exit(1)
  }

  try {
    const tokens = await exchangeCode(code, verifier)
    const id = crypto.randomUUID()
    
    db.run(
      `INSERT INTO accounts (id, name, refresh_token, access_token, expires_at, created_at) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name, tokens.refresh, tokens.access, tokens.expires, Date.now()]
    )
    
    console.log(`✅ Account "${name}" added successfully!`)
  } catch (error) {
    console.error("❌ Failed to exchange code:", error)
    process.exit(1)
  }
}

function listAccounts() {
  const accounts = db.query<Account, []>(`SELECT * FROM accounts ORDER BY created_at DESC`).all()
  
  if (accounts.length === 0) {
    console.log("No accounts found. Add one with: bun cli.ts add <name>")
    return
  }

  console.log("\n📊 Claude Accounts:")
  console.log("─".repeat(80))
  
  for (const account of accounts) {
    const lastUsed = account.last_used 
      ? new Date(account.last_used).toLocaleString() 
      : "Never"
    const tokenStatus = account.expires_at && account.expires_at > Date.now() 
      ? "✅ Valid" 
      : "⏳ Expired"
    
    console.log(`\n🔑 ${account.name}`)
    console.log(`   ID: ${account.id}`)
    console.log(`   Created: ${new Date(account.created_at).toLocaleString()}`)
    console.log(`   Last Used: ${lastUsed}`)
    console.log(`   Requests: ${account.request_count}`)
    console.log(`   Token: ${tokenStatus}`)
  }
  console.log("\n" + "─".repeat(80))
}

function removeAccount(name: string) {
  const result = db.run(`DELETE FROM accounts WHERE name = ?`, [name])
  
  if (result.changes === 0) {
    console.error(`❌ Account "${name}" not found`)
    process.exit(1)
  }
  
  console.log(`✅ Account "${name}" removed successfully`)
}

function resetStats() {
  db.run(`UPDATE accounts SET request_count = 0, last_used = NULL`)
  console.log("✅ Statistics reset for all accounts")
}

function clearHistory() {
  const result = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM requests").get()
  const count = result?.count || 0
  
  if (count === 0) {
    console.log("ℹ️  No request history to clear")
    return
  }
  
  // Clear the requests table
  db.run(`DELETE FROM requests`)
  
  console.log(`✅ Cleared ${count} request(s) from history`)
}

function showHelp() {
  console.log(`
Claude Load Balancer CLI

Usage:
  bun cli.ts <command> [options]

Commands:
  add <name> [--mode max|console]  Add a new Claude account
  list                              List all accounts and their stats
  remove <name>                     Remove an account
  reset-stats                       Reset usage statistics for all accounts
  clear-history                     Clear all request history
  help                              Show this help message

Examples:
  bun cli.ts add personal          Add a personal account (console.anthropic.com)
  bun cli.ts add work --mode max   Add a work account (claude.ai)
  bun cli.ts list                   Show all accounts
  bun cli.ts remove personal        Remove the personal account
`)
}

// Parse command line arguments
const { values, positionals } = parseArgs({
  args: Bun.argv,
  options: {
    mode: {
      type: "string",
      default: "console",
    },
  },
  strict: false,
  allowPositionals: true,
})

const command = positionals[2] // Skip bun and script path

switch (command) {
  case "add":
    const accountName = positionals[3]
    if (!accountName) {
      console.error("❌ Please provide an account name")
      console.log("Usage: bun cli.ts add <name> [--mode max|console]")
      process.exit(1)
    }
    const mode = values.mode as "max" | "console"
    if (mode !== "max" && mode !== "console") {
      console.error("❌ Invalid mode. Use 'max' or 'console'")
      process.exit(1)
    }
    await addAccount(accountName, mode)
    break
    
  case "list":
    listAccounts()
    break
    
  case "remove":
    const removeAccountName = positionals[3]
    if (!removeAccountName) {
      console.error("❌ Please provide an account name")
      console.log("Usage: bun cli.ts remove <name>")
      process.exit(1)
    }
    removeAccount(removeAccountName)
    break
    
  case "reset-stats":
    resetStats()
    break
    
  case "clear-history":
    clearHistory()
    break
    
  case "help":
  default:
    showHelp()
}