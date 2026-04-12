# Project Assessment Report

Date verified: April 10, 2026

## What this project is

This is a Next.js 16 app that presents a chatbot UI with multiple "AI safety" controls. Under the hood, it uses Groq for:

- Guardrails scoring through `meta-llama/llama-prompt-guard-2-22m`
- Chat generation through `llama-3.1-8b-instant`

The project is partly real and partly simulated. Some controls call live APIs, while several others only affect the client-side visualization.

## Verified live and working

The following pieces are real and were verified locally on April 10, 2026:

1. The app is running locally and responds on `http://localhost:3000`.
2. `POST /api/guardrails` is live and returns a real numeric risk score from Groq.
3. `POST /api/chat` is live and streams/returns real model output from Groq.
4. Prompt sanitization is implemented in shared code and is actually applied in both API routes.

Example verified responses:

- Guardrails test returned a high risk score (`0.9687045812606812`) for a jailbreak-style prompt.
- Chat test returned a valid assistant message (`Hello, how are you today?`).

## Live components vs mock components

### Live components

- `src/app/api/guardrails/route.ts`
  - Real server route
  - Calls Groq prompt guard model
  - Always sanitizes input before scoring

- `src/app/api/chat/route.ts`
  - Real server route
  - Calls Groq chat completion API
  - Streams real model output
  - Always sanitizes user messages before sending them upstream

- `src/lib/promptSanitizer.ts`
  - Real shared logic
  - Used by both backend routes
  - Detects/redacts jailbreak phrases, role leakage, script injection, secrets, PII, and some infrastructure strings

### Mostly mock or simulated components

- `Templating`
  - Only changes the client-side trace in `runSimulation`
  - Does not change the prompt sent to `/api/chat`

- `Sandbox`
  - Pure regex-based simulation in the browser
  - No real tool execution sandbox exists in the app

- `HITL`
  - Pure client-side threshold check
  - No real approval queue, reviewer workflow, or server-side pause

- `Output Filter`
  - Only masks what the user sees in the UI
  - Not enforced on the backend or persisted output

- `Trace / audit panel`
  - Useful for demonstration
  - Not a real backend audit system

## Current live problems

### 1. The UI claims some controls are independent, but they are not

The interface says all options are independent, but the backend always sanitizes user prompts in both `/api/guardrails` and `/api/chat`.

Impact:

- Turning `Sanitization` off in the UI does not actually disable sanitization for real API calls.
- The UI can mislead users into thinking they are testing raw prompts when they are not.

### 2. Guardrails scoring is performed on sanitized text, not the raw prompt

`/api/guardrails` sanitizes the message before sending it to the Groq guard model.

Impact:

- The risk score reflects a modified prompt, not the original user input.
- This can make the safety analysis less faithful for evaluation/demo purposes.

### 3. Most safety controls are demonstrations, not enforceable protections

Only sanitization plus the Groq guardrails/chat routes are real. Templating, sandboxing, HITL, and most audit behavior are simulated inside the client.

Impact:

- The product looks like a full control panel, but several controls are not operational security features.
- Anyone reviewing the app could overestimate its production readiness.

### 4. Production build is currently failing in this workspace

`npm run lint` passed, but `npm run build` failed with:

- `EPERM: operation not permitted, open 'c:\Users\TheIM\Desktop\CapStone\.next\trace-build'`

Impact:

- The project is not currently build-healthy in this environment.
- This looks like a file-lock/workspace state issue rather than an obvious TypeScript or ESLint issue.

### 5. README is still boilerplate and does not describe the real project

The current `README.md` is the default Next.js starter text.

Impact:

- New reviewers will not understand what is actually implemented.
- The project's real architecture and limitations are undocumented.

## Important implementation notes

- The frontend sanitizes the displayed user message before adding it to chat when the toggle is on.
- The backend sanitizes again regardless of toggle state.
- The "blocked" response shown in the trace is a local simulation choice based on the returned risk score and client threshold.
- The app depends on a local `GROQ_API_KEY`, and local environment configuration is present.

## Overall assessment

This project is best described as a live Groq-backed chatbot demo with a mixed real/simulated safety dashboard.

What is genuinely operational:

- Groq chat
- Groq prompt guard scoring
- Shared prompt sanitization
- Local running app

What is primarily demo logic:

- Templating
- Sandbox
- HITL
- Much of the processing trace and audit presentation
- "Independent" safety switch behavior

## Suggested next priorities

1. Make the UI honest about which controls are simulated versus enforced.
2. Decide whether sanitization should be a real configurable backend feature or always-on policy.
3. Score guardrails on raw input if the goal is accurate safety evaluation.
4. Fix the build-state issue around `.next/trace-build`.
5. Replace the boilerplate README with project-specific documentation.
