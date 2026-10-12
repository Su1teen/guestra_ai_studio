# Studio API v1

Base `/api`, cookie session. Error `{error:{code,message,retryable,correlationId}}`. API responses never include integration credentials/password hashes. Payload types and strict runtime schemas in `shared/domain.ts`; integration adapter contracts in `server/integrations.ts`.

| Route                                    | Role                  | Behavior                                                                                        |
| ---------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| GET health / ready                       | public                | Liveness; readiness executes SELECT1 against Studio PostgreSQL                                  |
| GET auth/options                         | public                | Explicit local preview availability                                                             |
| POST auth/local                          | local only            | Dev session, loopback/nonproduction only                                                        |
| POST auth/login                          | public                | email/password, scrypt, membership, rate limit10/min                                            |
| POST auth/logout                         | authenticated         | Delete session token hash, clear cookie                                                         |
| GET bootstrap                            | all                   | Workspace/user, clients, conversation refs, agents/prompts, scenarios/runs, notes/calls         |
| GET users / POST users                   | admin                 | Workspace-scoped team list / create account with email/name/password12+/role                    |
| GET integrations                         | all                   | Safe discovery/config states, mappings, unavailable trace/prompt/telephony flags                |
| PUT integrations/mode                    | admin                 | preview/crm/sandbox, capability guards; new chats only                                          |
| POST clients / PATCH clients/:id         | admin/tester          | Validated virtual profile; no real guest merge                                                  |
| POST conversations                       | admin/tester          | clientId/title/channel/stage/optional agentId; durable identity/ref/session                     |
| PATCH conversations/:id                  | admin/tester/reviewer | draft/verdict/unread; local-only handoff. Reviewer only verdict/unread                          |
| GET conversations/:id/timeline           | all                   | Confirmed guest messages, attempts/runs/notes/calls, cursor, disconnected cache status          |
| POST conversations/:id/messages          | admin/tester          | externalMessageId UUID, text, attachmentIds≤5, optional replyTo;202 queue acknowledgement       |
| POST attempts/:id/retry                  | admin/tester          | Failed attempt replay with original identity/correlation/payload key                            |
| POST runs/:id/retry                      | admin/tester          | Recover failed/unknown run using original attempt, immutable snapshot and correlation key       |
| POST media                               | admin/tester          | Raw octet-stream, X-File-Name URI encoded, X-File-Type;20MB/type validation/scanner             |
| GET media/:id/url                        | all                   | Authorized short-lived signed URL                                                               |
| GET media/:id/content                    | signed bearer URL     | Signature/workspace/id/purpose/expiry checks, authorized retention, safe disposition            |
| POST annotations / PATCH annotations/:id | admin/tester/reviewer | Conversation/message/run/tool/call target validation, author/severity/type/flags/history/status |
| POST agents                              | admin                 | Create agent profile/configuration and initial Studio prompt version                            |
| PATCH agents/:id                         | admin                 | model/workflow/timeout/retries/tool/flag configuration metadata                                 |
| POST agents/:id/prompts                  | admin                 | New draft body and optional parentId                                                            |
| PATCH prompts/:id                        | admin                 | Draft body only; published immutable                                                            |
| POST prompts/:id/publish                 | admin                 | Activate Studio registry version/rollback, audit; external sync NOT_CONNECTED                   |
| POST scenarios                           | admin/tester          | name/description/stage/opening/assertions                                                       |
| POST scenarios/:id/run                   | admin/tester          | clientId/channel; separate chat, setup state, persisted pending assertions                      |
| POST scenario-runs/:id/evaluate          | admin/tester/reviewer | Text/delivery assertions, no fake operational verification                                      |
| POST calls                               | admin/tester          | conversationId/direction/optional runId; virtual ringing session                                |
| POST calls/:id/action                    | admin/tester          | accept/reject/end with validated transitions/duration                                           |
| POST calls/:id/turns                     | admin/tester          | Active session speaker/text/optional authorized audio mediaId                                   |
| GET audit                                | admin/reviewer        | Safe workspace change summaries                                                                 |
| POST integrations/n8n/events             | HMAC only             | Exact raw bytes, timestamp window, unique receipt, monotonic callbacks, CRM read-back           |

Viewer cannot mutate records or upload. Reviewer cannot send guest messages or configure agents/integrations. Every foreign resource is looked up within the authenticated workspace. SameSite/Origin checks protect browser mutations; redirects to credential-bearing upstreams are rejected. Signed media grants narrowly scoped temporary read access, never write access.

Team provisioning: authenticate bootstrap admin, POST users with a dedicated password supplied by the operator. Do not place passwords in docs/logs or shell arguments; use a protected local request body/tool. Auth login selects the user's first membership; multi-workspace account switching/UI provisioning is a future extension. Workspace isolation is already enforced by composite keys and repositories.

Guest timeline currently returns the complete bounded window with nextCursor on each poll, allowing changed delivery/media states to refresh. CRM adapter itself polls pages by after cursor and performs full reconciliation because upstream sentAt mutates. A future immutable changes API can replace the full-window poll without changing guest UI ownership.
