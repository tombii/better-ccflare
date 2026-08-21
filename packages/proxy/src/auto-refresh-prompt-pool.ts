/**
 * The prompts the auto-refresh probe sends, and the lock that stops any of them
 * from being sent twice in a day.
 *
 * The probe exists to make an account answer once so the provider re-states its
 * usage window. It could do that with a single "." — and would spend a fraction
 * of the tokens — but the request is automated, unattended, and repeats for as
 * long as the server runs. The surrounding code is built to make it look like
 * what it is standing in for: real Claude Code CLI traffic, with the CLI's own
 * user agent and header set, sent through the proxy rather than straight at the
 * provider, carrying a question a person might plausibly have typed. A fixed
 * string repeated forever is the one part of that disguise that cannot hold, so
 * the prompt is drawn at random from a large pool and every drawn prompt is then
 * locked out for 24 hours.
 *
 * Two consequences worth naming, because they are the point rather than side
 * effects:
 *
 * - The pool is shared by every account. Whoever claims a prompt first gets it,
 *   and the next caller — same tick, same millisecond — is handed a different
 *   one. No two accounts can be seen sending the same text at the same moment.
 * - Running the pool dry is not a routine condition. It takes 500 refreshes
 *   inside 24 hours, and a healthy install does a handful. If the claim starts
 *   refusing, something is looping, and refusing is the correct answer: it
 *   reports when the first prompt comes back and sends nothing until then.
 */

/**
 * 500 short prompts. Short is a requirement, not an aesthetic: input is what the
 * probe pays for (its reply is capped at ten tokens and thrown away), so every
 * entry is a single plain question or instruction. They are also deliberately
 * uneven in shape — questions, imperatives, greetings, fragments — because 500
 * variations of "What is X?" would be as recognisable as one repeated string.
 */
export const AUTO_REFRESH_PROMPTS: readonly string[] = [
	// The original five, kept exactly as they were.
	"Write a hello world program in Python",
	"What is 2+2?",
	"Tell me a programmer joke",
	"What is the capital of France?",
	"Explain recursion in one sentence",

	// ── arithmetic and small numbers ─────────────────────────────────────────
	"What is 7 times 8?",
	"What is 100 divided by 4?",
	"What is 15 minus 9?",
	"What is the square root of 81?",
	"What is 2 to the power of 10?",
	"What is 12 percent of 200?",
	"What is half of 46?",
	"Is 91 a prime number?",
	"What is the next prime after 13?",
	"What is 3 factorial?",
	"Round 7.62 to one decimal place.",
	"What is the sum of 1 through 10?",
	"What is 0.1 plus 0.2?",
	"How many minutes are in three hours?",
	"What is 45 in binary?",
	"What is 255 in hexadecimal?",
	"What is the average of 4, 8 and 12?",
	"What is 1000 divided by 8?",
	"What is 17 modulo 5?",
	"Is 2024 a leap year?",
	"What is the greatest common divisor of 12 and 18?",
	"What is 5 squared plus 5?",
	"How many seconds are in a day?",
	"What is one third as a decimal?",
	"What is the area of a 3 by 4 rectangle?",
	"What is 20 percent off 50?",
	"What is the perimeter of a square with side 6?",
	"Convert 0.75 to a fraction.",
	"What is 9 times 9?",
	"What comes next: 2, 4, 8, 16?",
	"What is negative 5 plus 12?",
	"How many degrees are in a triangle?",
	"What is pi to two decimal places?",
	"What is 144 divided by 12?",
	"What is the cube of 3?",
	"How many bytes are in a kilobyte?",
	"What is 2 to the power of 16?",
	"What is the median of 1, 3 and 100?",
	"Is 0 an even number?",
	"What is 6 divided by 3?",

	// ── geography ────────────────────────────────────────────────────────────
	"What is the capital of Japan?",
	"What is the capital of Brazil?",
	"What is the capital of Canada?",
	"What is the capital of Australia?",
	"What is the capital of Portugal?",
	"What is the capital of Egypt?",
	"What is the largest ocean?",
	"What is the longest river in the world?",
	"Which continent is Chile on?",
	"What is the tallest mountain on Earth?",
	"How many continents are there?",
	"What is the smallest country in the world?",
	"Which country has the most people?",
	"What ocean lies between Europe and America?",
	"What is the capital of Norway?",
	"Name the three Baltic states.",
	"What desert covers most of northern Africa?",
	"Which country is Mount Fuji in?",
	"What is the capital of Kenya?",
	"Which two countries share the longest border?",
	"What sea is Cyprus in?",
	"What is the capital of Chile?",
	"Which country is surrounded by South Africa?",
	"What is the capital of Iceland?",
	"Which river runs through Cairo?",
	"What is the largest island in the world?",
	"What is the capital of Peru?",
	"Which country is Bali part of?",
	"What is the capital of Vietnam?",
	"How many time zones does Russia have?",
	"What is the deepest ocean trench?",
	"Which country is famous for its fjords?",
	"What is the capital of Morocco?",
	"Which lake is the largest by area?",
	"What is the capital of New Zealand?",

	// ── computing vocabulary ─────────────────────────────────────────────────
	"What is an API in one sentence?",
	"What does HTTP stand for?",
	"What is a database index?",
	"What is a compiler?",
	"What is an operating system?",
	"What is a variable in programming?",
	"What is a function?",
	"What is a linked list?",
	"What is a hash table?",
	"What is a binary search?",
	"What is Big O notation?",
	"What is a race condition?",
	"What is a deadlock?",
	"What is a memory leak?",
	"What is garbage collection?",
	"What is a pointer?",
	"What is a stack overflow?",
	"What is a queue in computing?",
	"What is a stack in computing?",
	"What is a REST endpoint?",
	"What is JSON used for?",
	"What is a webhook?",
	"What is a load balancer?",
	"What is a reverse proxy?",
	"What is DNS for?",
	"What is TCP?",
	"What is UDP?",
	"What is TLS?",
	"What is a firewall?",
	"What is a VPN?",
	"What is a container?",
	"What is a virtual machine?",
	"What is CI in software?",
	"What is a merge conflict?",
	"What is a pull request?",
	"What is version control?",
	"What is a code review?",
	"What is unit testing?",
	"What is a mock in testing?",
	"What is technical debt?",
	"What is refactoring?",
	"What is a design pattern?",
	"What is object oriented programming?",
	"What is functional programming?",
	"What is immutability?",
	"What is a closure in JavaScript?",
	"What is a promise in JavaScript?",
	"What is a generator function?",
	"What is type inference?",
	"What is a null pointer?",

	// ── tiny code questions ──────────────────────────────────────────────────
	"Write a one line Python list comprehension.",
	"How do I reverse a string in Python?",
	"How do I read a file in Python?",
	"Show a Python dictionary literal.",
	"How do I sort a list in Python?",
	"What does len() do in Python?",
	"How do I define a class in Python?",
	"Show a Python f-string example.",
	"How do I catch an exception in Python?",
	"What is a Python decorator?",
	"How do I install a package with pip?",
	"How do I create a virtual environment in Python?",
	"Write a JavaScript arrow function.",
	"How do I map over an array in JavaScript?",
	"What does === mean in JavaScript?",
	"How do I parse JSON in JavaScript?",
	"How do I declare a constant in JavaScript?",
	"Show a JavaScript template literal.",
	"How do I filter an array in JavaScript?",
	"What is the difference between let and var?",
	"How do I write an async function in JavaScript?",
	"How do I await a promise?",
	"Show a TypeScript interface.",
	"How do I type a function in TypeScript?",
	"What does readonly do in TypeScript?",
	"How do I make a field optional in TypeScript?",
	"What is a union type?",
	"How do I print in Go?",
	"How do I declare a slice in Go?",
	"What does defer do in Go?",
	"How do I handle errors in Go?",
	"How do I write a struct in Rust?",
	"What does the borrow checker do?",
	"How do I create a vector in Rust?",
	"What is Option in Rust?",
	"How do I print in C?",
	"What does malloc do?",
	"How do I write a for loop in Java?",
	"What is a Java interface?",
	"How do I write hello world in Ruby?",
	"How do I write hello world in PHP?",
	"How do I write hello world in Bash?",
	"How do I make an HTTP GET request in Python?",
	"How do I write a SQL select with a where clause?",
	"How do I join two tables in SQL?",
	"What does GROUP BY do in SQL?",
	"How do I count rows in SQL?",
	"What does LIMIT do in SQL?",
	"How do I add a column in SQL?",
	"What is a primary key?",
	"What is a foreign key?",
	"How do I write a CSS flexbox container?",
	"How do I center a div with CSS?",
	"What does display none do?",
	"How do I add a comment in HTML?",
	"What does the alt attribute do?",
	"How do I link a stylesheet in HTML?",
	"What is a semantic HTML tag?",
	"How do I write a regex for digits?",
	"How do I escape a dot in a regex?",

	// ── conversions ──────────────────────────────────────────────────────────
	"How many centimeters are in an inch?",
	"Convert 100 Fahrenheit to Celsius.",
	"Convert 5 kilometers to miles.",
	"How many grams are in a pound?",
	"How many liters are in a gallon?",
	"Convert 72 hours to days.",
	"How many feet are in a meter?",
	"Convert 1 megabyte to bytes.",
	"How many milliliters are in a cup?",
	"Convert 90 degrees to radians.",
	"How many ounces are in a kilogram?",
	"Convert 2 weeks to hours.",
	"How many square feet are in a square meter?",
	"Convert 30 mph to km/h.",
	"How many minutes are in a week?",
	"Convert 1 terabyte to gigabytes.",
	"How many days are in a leap year?",
	"Convert 0 Celsius to Kelvin.",
	"How many inches are in a yard?",
	"Convert 250 grams to ounces.",
	"How many seconds are in an hour?",
	"Convert 12 pm to 24 hour time.",
	"How many milligrams are in a gram?",
	"Convert 3 tablespoons to teaspoons.",
	"How many hours are in a fortnight?",
	"Convert 1 mile to meters.",
	"How many bits are in a byte?",
	"Convert 45 minutes to seconds.",
	"How many weeks are in a year?",
	"Convert 1024 kilobytes to megabytes.",

	// ── quick yes or no ──────────────────────────────────────────────────────
	"Is the sky blue?",
	"Is water wet?",
	"Do penguins fly?",
	"Is the sun a star?",
	"Is Pluto a planet?",
	"Can cats swim?",
	"Is glass a liquid?",
	"Do fish sleep?",
	"Can honey spoil?",
	"Are tomatoes fruit?",
	"Is lightning hotter than the sun?",
	"Do plants need light?",
	"Is sound faster than light?",
	"Can humans see infrared?",
	"Is Mount Everest still growing?",
	"Do sharks have bones?",
	"Is coffee a fruit?",
	"Are all metals magnetic?",
	"Does the moon have gravity?",
	"Is 1 a prime number?",
	"Do spiders have antennae?",
	"Is a peanut a nut?",
	"Can sound travel in space?",
	"Is gold heavier than silver?",
	"Do birds have teeth?",
	"Is Antarctica a desert?",
	"Are viruses alive?",
	"Is rust a chemical reaction?",
	"Do octopuses have three hearts?",
	"Is helium lighter than air?",

	// ── words and language ───────────────────────────────────────────────────
	"How do you spell necessary?",
	"What is the plural of cactus?",
	"What is a synonym for quick?",
	"What is an antonym for hot?",
	"What does ubiquitous mean?",
	"Is it affect or effect?",
	"What is the past tense of go?",
	"How do you say thank you in Japanese?",
	"How do you say hello in Portuguese?",
	"What does et cetera mean?",
	"What is an oxymoron?",
	"What is a palindrome?",
	"Give an example of alliteration.",
	"What is a long English word?",
	"What does bona fide mean?",
	"Is it fewer or less?",
	"What is a gerund?",
	"What does laconic mean?",
	"How do you say goodbye in Italian?",
	"What is the difference between its and it's?",
	"What does verbatim mean?",
	"What is a homonym?",
	"How do you spell rhythm?",
	"What is the plural of mouse?",
	"What does ephemeral mean?",
	"How do you say water in German?",
	"What is a metaphor?",
	"What does candid mean?",
	"Is it who or whom?",
	"What does pragmatic mean?",

	// ── shell and git ────────────────────────────────────────────────────────
	"How do I list files in a directory?",
	"How do I check disk usage?",
	"How do I find a file by name?",
	"How do I search for text in files?",
	"How do I make a directory?",
	"How do I copy a file?",
	"How do I move a file?",
	"How do I delete a directory?",
	"How do I see running processes?",
	"How do I kill a process by name?",
	"How do I check free memory?",
	"How do I see the last lines of a file?",
	"How do I count the lines in a file?",
	"How do I change file permissions?",
	"How do I create a symbolic link?",
	"How do I print my current directory?",
	"How do I list environment variables?",
	"How do I set an environment variable?",
	"How do I make a file executable?",
	"How do I compress a folder?",
	"How do I extract a tar file?",
	"How do I check my IP address?",
	"How do I test whether a port is open?",
	"How do I see open network connections?",
	"How do I check the system uptime?",
	"How do I create a new git branch?",
	"How do I switch git branches?",
	"How do I see the git log in one line?",
	"How do I undo the last commit?",
	"How do I stash changes in git?",
	"How do I see what changed in git?",
	"How do I add a git remote?",
	"How do I tag a commit in git?",
	"How do I discard local changes in git?",
	"How do I see which branch I am on?",
	"How do I rename a git branch?",
	"How do I cherry pick a commit?",
	"How do I see a file's history in git?",
	"How do I revert a commit?",
	"How do I clone a repository?",

	// ── light and playful ────────────────────────────────────────────────────
	"Tell me a very short pun.",
	"Tell me a one line joke about coffee.",
	"Tell me a joke about cats.",
	"Say something cheerful.",
	"Give me a fun fact.",
	"Tell me a riddle.",
	"Give me a two word compliment.",
	"What is a fun fact about octopuses?",
	"Tell me a dad joke.",
	"Give me a motivational sentence.",
	"Tell me something surprising.",
	"What is a good name for a robot?",
	"Give me a random animal name.",
	"Suggest a name for a cat.",
	"Tell me a joke about databases.",
	"Give me a haiku about rain.",
	"What is a fun fact about honey?",
	"Tell me a joke about time zones.",
	"Suggest a color for a bicycle.",
	"Answer with one word: yes or no?",
	"Say hello in a friendly way.",
	"Tell me a fun fact about the moon.",
	"Give me a short tongue twister.",
	"Suggest a title for a blog post about tea.",
	"Tell me a joke about regular expressions.",

	// ── time and dates ───────────────────────────────────────────────────────
	"How many days are in February?",
	"What day comes after Tuesday?",
	"How many weeks are in a quarter?",
	"What is the first month of the year?",
	"How many days are in a fortnight?",
	"What is UTC?",
	"How many hours ahead of London is Tokyo?",
	"What is a leap second?",
	"How many months have 31 days?",
	"What is the last month of the year?",
	"What is the shortest day of the year?",
	"What does AM stand for?",
	"How many days are in a decade?",
	"What is an epoch timestamp?",
	"What time zone is Lisbon in?",
	"How many quarters are in a year?",
	"How long is a millennium?",
	"What is daylight saving time?",
	"How many hours are in a week?",
	"What is the middle month of the year?",

	// ── explain in one sentence ──────────────────────────────────────────────
	"Explain gravity in one sentence.",
	"Explain photosynthesis in one sentence.",
	"Explain inflation in one sentence.",
	"Explain a black hole in one sentence.",
	"Explain DNA in one sentence.",
	"Explain evolution in one sentence.",
	"Explain electricity in one sentence.",
	"Explain a rainbow in one sentence.",
	"Explain the water cycle in one sentence.",
	"Explain machine learning in one sentence.",
	"Explain encryption in one sentence.",
	"Explain a blockchain in one sentence.",
	"Explain compound interest in one sentence.",
	"Explain supply and demand in one sentence.",
	"Explain a vaccine in one sentence.",
	"Explain antibiotics in one sentence.",
	"Explain plate tectonics in one sentence.",
	"Explain a tsunami in one sentence.",
	"Explain the greenhouse effect in one sentence.",
	"Explain osmosis in one sentence.",
	"Explain a magnet in one sentence.",
	"Explain sound in one sentence.",
	"Explain a prism in one sentence.",
	"Explain friction in one sentence.",
	"Explain inertia in one sentence.",
	"Explain a catalyst in one sentence.",
	"Explain fermentation in one sentence.",
	"Explain a solar eclipse in one sentence.",
	"Explain the tides in one sentence.",
	"Explain why the sky is blue in one sentence.",
	"Explain a neural network in one sentence.",
	"Explain caching in one sentence.",
	"Explain a queue in one sentence.",
	"Explain an interpreter in one sentence.",
	"Explain a transaction in one sentence.",
	"Explain idempotency in one sentence.",
	"Explain rate limiting in one sentence.",
	"Explain a cookie in one sentence.",
	"Explain a session in one sentence.",
	"Explain latency in one sentence.",

	// ── name three ───────────────────────────────────────────────────────────
	"Name three primary colors.",
	"Name three planets.",
	"Name three programming languages.",
	"Name three fruits.",
	"Name three musical instruments.",
	"Name three chemical elements.",
	"Name three oceans.",
	"Name three Nordic countries.",
	"Name three HTTP methods.",
	"Name three SQL keywords.",
	"Name three Linux distributions.",
	"Name three text editors.",
	"Name three data structures.",
	"Name three sorting algorithms.",
	"Name three image formats.",
	"Name three shell commands.",
	"Name three git commands.",
	"Name three units of length.",
	"Name three prime numbers.",
	"Name three shapes.",
	"Name three types of cloud.",
	"Name three vegetables.",
	"Name three birds.",
	"Name three metals.",
	"Name three board games.",

	// ── one or two words back ────────────────────────────────────────────────
	"Say hi.",
	"How are you today?",
	"Good morning.",
	"Thanks for your help.",
	"Are you there?",
	"Can you hear me?",
	"Just checking in.",
	"Nothing to do here.",
	"Please reply with ok.",
	"Reply with a single word.",
	"Say the word ready.",
	"Confirm you are online.",
	"Answer with yes.",
	"Give a one word greeting.",
	"What is your favorite color?",
	"Do you like puzzles?",
	"Pick a number between 1 and 10.",
	"Flip a coin for me.",
	"Choose tea or coffee.",
	"Say something in one word.",
	"Count to three.",
	"Repeat the word test.",
	"Say the first three letters of the alphabet.",
	"Give me a thumbs up.",
	"What is 1 plus 1?",
	"Are you ready?",
	"Say ping.",
	"Reply with pong.",
	"Tell me the shortest sentence you know.",
	"Say goodbye.",

	// ── acronyms ─────────────────────────────────────────────────────────────
	"What does CPU stand for?",
	"What does RAM stand for?",
	"What does SSD stand for?",
	"What does URL stand for?",
	"What does HTML stand for?",
	"What does CSS stand for?",
	"What does SQL stand for?",
	"What does API stand for?",
	"What does JSON stand for?",
	"What does XML stand for?",
	"What does FTP stand for?",
	"What does SSH stand for?",
	"What does DNS stand for?",
	"What does VPN stand for?",
	"What does GPU stand for?",
	"What does USB stand for?",
	"What does PDF stand for?",
	"What does LED stand for?",
	"What does GPS stand for?",
	"What does ISO stand for?",

	// ── general knowledge ────────────────────────────────────────────────────
	"Who wrote Hamlet?",
	"Who painted the Mona Lisa?",
	"When was the first moon landing?",
	"Who invented the telephone?",
	"What year did World War II end?",
	"Who discovered penicillin?",
	"What is the speed of light?",
	"Who developed the theory of relativity?",
	"What is the chemical symbol for gold?",
	"What is the chemical symbol for iron?",
	"How many bones are in the human body?",
	"What is the largest organ in the body?",
	"What gas do plants absorb?",
	"What is the hardest natural material?",
	"How many chambers does the heart have?",
	"What is the boiling point of water?",
	"Which planet is closest to the sun?",
	"What is the smallest unit of matter?",
	"Who wrote Don Quixote?",
	"What is the currency of Japan?",
];

/**
 * How long a prompt stays out of circulation after being sent. A day is the unit
 * a human would use to reason about "we already said that recently", and it makes
 * the pool's capacity legible: 500 prompts and a 24-hour lock means 500 probes
 * per day before the mechanism has anything to say.
 */
export const PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * When each prompt was last claimed, by its index in the array above. Bounded by
 * the pool size, so it needs no eviction; a claim on an expired entry overwrites
 * it. In memory only, and deliberately so — the state it protects is "did we say
 * this in the last day", and a restart losing it costs one 1-in-500 chance of an
 * early repeat, which is not worth a schema migration.
 */
const claimedAt = new Map<number, number>();

export type AutoRefreshPromptClaim =
	| { ok: true; prompt: string; index: number }
	| { ok: false; retryAt: number };

/** Forget every claim. Exposed for tests. */
export function resetAutoRefreshPromptPoolForTests(): void {
	claimedAt.clear();
}

/**
 * Take a prompt out of the pool and lock it for the next 24 hours.
 *
 * The whole function is synchronous and marks its choice before returning, with
 * no await anywhere inside. That is what makes "first one wins" true rather than
 * merely likely: two accounts refreshing in the same tick cannot both be handed
 * the same prompt, because the first call has already stamped it by the time the
 * second one looks. The second gets whatever the pool says next — another free
 * prompt if there is one, or the time the earliest locked prompt comes back.
 *
 * @returns the claimed prompt, or `retryAt`: the moment the first prompt is free
 * again, for a caller that should try later instead of sending anything now.
 */
export function claimAutoRefreshPrompt(
	now: number = Date.now(),
): AutoRefreshPromptClaim {
	const free: number[] = [];
	let earliestRelease = Number.POSITIVE_INFINITY;

	for (let index = 0; index < AUTO_REFRESH_PROMPTS.length; index++) {
		const last = claimedAt.get(index);
		if (last === undefined) {
			free.push(index);
			continue;
		}
		const release = last + PROMPT_COOLDOWN_MS;
		if (release <= now) {
			free.push(index);
			continue;
		}
		if (release < earliestRelease) earliestRelease = release;
	}

	if (free.length === 0) {
		return { ok: false, retryAt: earliestRelease };
	}

	const index = free[Math.floor(Math.random() * free.length)];
	claimedAt.set(index, now);
	return { ok: true, prompt: AUTO_REFRESH_PROMPTS[index], index };
}

/**
 * Put a prompt back into circulation.
 *
 * The lock exists to stop the same text being *sent* twice inside a day, so a
 * claim that never became a request is not a lock — it is a leak. The claim has
 * to happen before the caller knows whether it can send at all (a provider that
 * is not registered, a token that will not refresh), and this is how it gives
 * the prompt back on those paths.
 *
 * Deliberately not for the other kind of failure. Once a request has been
 * issued the text was sent, whatever the provider answered — including a 529
 * overload — and remembering that is the pool's entire job. Handing the prompt
 * back there would let the same text go out twice in a minute, which is the one
 * thing the cooldown exists to prevent.
 *
 * Idempotent: releasing an index that is already free does nothing.
 */
export function releaseAutoRefreshPrompt(index: number): void {
	claimedAt.delete(index);
}

/**
 * What the pool looks like right now, without claiming anything. For log lines
 * and for anyone who wants to see how close to dry it is.
 */
export function autoRefreshPromptPoolStatus(now: number = Date.now()): {
	free: number;
	total: number;
	retryAt: number | null;
} {
	let free = 0;
	let earliestRelease = Number.POSITIVE_INFINITY;

	for (let index = 0; index < AUTO_REFRESH_PROMPTS.length; index++) {
		const last = claimedAt.get(index);
		if (last === undefined || last + PROMPT_COOLDOWN_MS <= now) {
			free++;
			continue;
		}
		earliestRelease = Math.min(earliestRelease, last + PROMPT_COOLDOWN_MS);
	}

	return {
		free,
		total: AUTO_REFRESH_PROMPTS.length,
		retryAt: Number.isFinite(earliestRelease) ? earliestRelease : null,
	};
}
