# Future n8n sandbox workflow

No workflow is deployed by this repository. A usable n8n adapter requires the contract in [INTEGRATION_CONTRACTS](../../docs/INTEGRATION_CONTRACTS.md), not a text-only webhook mock.

Implementation order:

1. Authenticated webhook validates studio-gateway-v1, sandbox, simulator and allowed property. Store workspace/chat/message key in a durable execution ledger before returning accepted=true.
2. Claim one run per external chat. POST exactly one CRM inbound; record response IDs and signed inbound_saved event.
3. Load/sanitize context; stop AI execution for aiReplyAllowed=false, record human_owned. Intersect configured tools with authoritative allowedActions.
4. Invoke CRM commercial tools and PMS operational tools using stable operation idempotency keys. Treat payment-ready/authorized as separate from settled payment.
5. Prepare CRM outbound and confirm simulator result. Read authoritative transcript, then emit signed completed callback. Failure emits safe errorCode.
6. On duplicate dispatch, return existing execution and replay its latest callback. Do not rerun booking/service/payment tools. Expose capability and future read-only execution endpoints.

Store credentials in n8n credentials, not workflow exports. Never put tester annotations, private CRM notes or hidden model reasoning into guest input/output. Media links have5min lifetime; refresh requires a scoped storage exchange provider when execution is delayed. Agent-origin media remains a CRM contract gap.
