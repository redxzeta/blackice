import { parseEnvelope } from '../envelope.js';
import { chooseActionModel, chooseChatModel } from '../router.js';
import type { ChatCompletionRequest } from '../schema.js';
import { ROUTE_KIND } from '../routeKind.js';

export type ResolvedRoute =
  | {
      envelope: ReturnType<typeof parseEnvelope>;
      route: {
        kind: typeof ROUTE_KIND.ACTION;
        action: string;
        routerModel: string;
        workerModel: string;
        reason: string;
      };
    }
  | {
      envelope: ReturnType<typeof parseEnvelope>;
      route: {
        kind: typeof ROUTE_KIND.CHAT;
        workerModel: string;
        reason: string;
        stream: boolean;
      };
    };

export function resolveRoute(body: ChatCompletionRequest): ResolvedRoute {
  const envelope = parseEnvelope(body.messages);

  if (envelope.kind === ROUTE_KIND.ACTION) {
    const actionDecision = chooseActionModel(envelope.action.action);

    return {
      envelope,
      route: {
        kind: ROUTE_KIND.ACTION,
        action: envelope.action.action,
        routerModel: `router/action/${envelope.action.action}`,
        workerModel: actionDecision.model,
        reason: actionDecision.reason
      }
    };
  }

  const chatDecision = chooseChatModel(body.messages);

  return {
    envelope,
    route: {
      kind: ROUTE_KIND.CHAT,
      workerModel: chatDecision.model,
      reason: chatDecision.reason,
      stream: Boolean(body.stream)
    }
  };
}

export function buildDryRunResponse(body: ChatCompletionRequest) {
  const resolved = resolveRoute(body);

  return {
    mode: 'dry_run',
    execute: false,
    envelope: {
      kind: resolved.envelope.kind,
      raw: resolved.envelope.raw
    },
    route: resolved.route
  };
}
