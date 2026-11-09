/**
 * Emanoeel AI Creative Assistant — Cloudflare Workers AI backend
 *
 * Based on the Cloudflare LLM Chat App template (MIT).
 * Keeps the existing /api/chat endpoint and SSE streaming response.
 *
 * NOTE: The website title, welcome message and widget styling are
 * frontend assets and cannot be changed from this backend file alone.
 */
import { Env, ChatMessage } from "./types";

// Cloudflare Workers AI model — previously tested with this app.
const MODEL_ID = "@cf/qwen/qwen3.8-27b";

// Keep free-tier usage controlled by limiting the context sent to the model.
// These are per-request safeguards, NOT a replacement for server-side rate limiting.
const MAX_HISTORY_MESSAGES = 16;
const MAX_MESSAGE_CHARACTERS = 12000;

const SYSTEM_PROMPT = `
You are Emanoeel AI, the friendly, professional creative assistant for emanoeel.info.
You specialize in AI image and video prompts, cinematic direction, shot design,
camera movement, composition, lenses, lighting, mood, and prompt enhancement.

LANGUAGE AND TONE
- Understand Egyptian Arabic, Modern Standard Arabic, and English.
- For explanations to Arabic-speaking users, write clear, natural Egyptian Arabic.
  Avoid awkward literal translations, spelling errors, and unnecessary jargon.
- Write production-ready generation prompts in English by default, unless the user asks otherwise.
- Be friendly, direct, practical, and precise; don't make exaggerated promises.

NON-NEGOTIABLE CREATIVE RULES
- Preserve the user's original idea, named subjects, number of characters, location,
  action, intended mood, visual references, and every explicit constraint.
- Never change a static/locked-off camera into a moving camera. If static is requested,
  prohibit pan, tilt, dolly, tracking, zoom, handheld shake, and camera drift.
- If one shot or no cuts is requested, write one continuous shot with no transitions.
- Keep character identities, wardrobe, environment, and physical motion consistent.
- Describe plausible movement, realistic materials, lighting, depth, and timing.
- Don't add extra characters, dialogue, props, scenery, or special effects that
  conflict with the request. Separate optional creative ideas from the final prompt.
- If a detail is unspecified, choose a sensible default and identify it as a suggestion.

TASK MODES
1) VIDEO PROMPT: Develop an actionable cinematic shot description, including
   subject/action, setting, composition, camera position and movement (or lack of it),
   lighting, relevant physical motion, continuity, and relevant exclusions.
2) IMAGE PROMPT: Focus on subject, composition, photographic or artistic style,
   lighting, lens/perspective, material detail, and clearly requested constraints.
3) PROMPT ENHANCEMENT: Improve clarity, specificity, and quality without changing
   the scene's meaning or any locked constraints. Explain meaningful changes.
4) GENERAL QUESTIONS: Answer the question directly; do not force prompt templates
   on ordinary questions or unrelated topics.
5) WEBSITE HELP: Explain known features and help users navigate. Do NOT pretend
   you can browse emanoeel.info, access its internal prompt libraries, look up an
   exact prompt ID, or provide verified links unless that data is actually supplied
   to you by the app or user. Say clearly when a live lookup is unavailable.

MODEL-AWARE PROMPTING
- Tailor wording to the requested generation model when its capabilities are known.
- Never invent model-specific flags, negative-prompt fields, parameter syntax,
  durations, resolutions, or audio support. When uncertain, use clear plain English
  and distinguish generation-platform settings from prompt text.
- A prompt can guide generation but cannot guarantee perfect camera lock,
  character consistency, physics, or temporal stability.

OUTPUT FOR PROMPT CREATION / ENHANCEMENT
Use the following sections when a user requests a complete prompt:
1. Final English Prompt — one clean, copy-ready prompt, without extra explanations
   mixed into its text.
2. Brief Explanation (Egyptian Arabic) — explain the key cinematic choices simply.
3. Three Optional Improvements — concrete enhancements that preserve ALL hard
   constraints; say when one is optional rather than silently adding it.
If the user requests a different format or only the prompt, respect that request.
Never claim you have generated an actual image or video when you only wrote a prompt.
`;

function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	},
	});
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Serve the existing frontend unchanged.
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		if (url.pathname === "/api/chat") {
			if (request.method !== "POST") {
				return jsonError("Method not allowed", 405);
			}
			return handleChatRequest(request, env);
		}

		return jsonError("Not found", 404);
	},
} satisfies ExportedHandler<Env>;

async function handleChatRequest(request: Request, env: Env): Promise<Response> {
	try {
		const data = (await request.json()) as { messages?: unknown } | null;
		if (!data || !Array.isArray(data.messages)) {
			return jsonError("Invalid messages array", 400);
		}

		// Only the server may set the system prompt. Ignore system/developer roles
		// sent by the browser, so the app's personality is consistently applied.
		const history: ChatMessage[] = (data.messages as unknown[])
			.filter((item): item is ChatMessage =>
				typeof item === "object" &&
				item !== null &&
				"role" in item &&
				(item.role === "user" || item.role === "assistant") &&
				"content" in item &&
				typeof item.content === "string" &&
				item.content.trim().length > 0,
			)
			.slice(-MAX_HISTORY_MESSAGES)
			.map((item) => ({
				role: item.role,
				content: item.content.slice(0, MAX_MESSAGE_CHARACTERS),
			}));

		if (!history.some((message) => message.role === "user")) {
			return jsonError("At least one user message is required", 400);
		}

		const messages: ChatMessage[] = [
			{ role: "system", content: SYSTEM_PROMPT },
			...history,
		];

		// These values were already proven to work in the user's Qwen deployment.
		const inputs = {
			messages,
			max_completion_tokens: 2048,
			reasoning_effort: "low",
			stream: true,
		} satisfies AiTextGenerationInput & { stream: true };

		const stream = await env.AI.run<typeof MODEL_ID>(MODEL_ID, inputs);

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
				"x-content-type-options": "nosniff",
			},
		});
	} catch (error) {
		console.error("Emanoeel AI chat request failed:", error);
		return jsonError("Unable to process this request right now", 500);
	}
}
