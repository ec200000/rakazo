import { Trans, useLingui } from "@lingui/react/macro";
import type { CronFreq, CronPreset } from "@rakazo/core";
import { cronFromPreset, defaultCronPreset } from "@rakazo/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { Clock, Eye, GitBranch, Globe, Mail, MessageSquare, Plus } from "lucide-react";
import { cronFreqLabel } from "../../lib/cron";
import type { RoutineDraftState } from "../../lib/routine-draft";
import { emptyWatchDraft } from "../../lib/routine-draft";

const SCHEDULE_PRESETS: CronFreq[] = [
  "Every hour",
  "Every day",
  "Weekdays",
  "Every week",
  "Every month",
  "Interval",
  "Advanced",
];

/** The menu that adds a schedule, message, change, email, Git, or webhook trigger. */
export function AddTriggerMenu({
  draft,
  onChange,
  fieldId,
  messageProviders,
  emailAvailable,
  webhookConfigured,
  onEnsureWebhook,
}: {
  draft: RoutineDraftState;
  onChange: (next: RoutineDraftState) => void;
  fieldId: string;
  messageProviders: string[];
  /** Whether this server receives email for the bot. */
  emailAvailable: boolean;
  webhookConfigured: boolean;
  onEnsureWebhook: () => Promise<void>;
}) {
  const { t } = useLingui();
  // Echo is this deployment's team chat; it takes the place Slack has upstream.
  const echoAvailable = messageProviders.includes("echo");
  const echoDisabledReasonId = `${fieldId}-echo-disabled-reason`;

  function addSchedule(freq: CronFreq) {
    const base = defaultCronPreset();
    const next: CronPreset =
      freq === "Advanced" ? { ...base, freq, cron: cronFromPreset(base) } : { ...base, freq };
    onChange({ ...draft, schedules: [...draft.schedules, next] });
  }

  async function addWebhook() {
    onChange({ ...draft, webhookEnabled: true });
    if (!webhookConfigured) {
      await onEnsureWebhook();
    }
  }

  async function addGithub() {
    onChange({ ...draft, githubEnabled: true });
    if (!webhookConfigured) {
      await onEnsureWebhook();
    }
  }

  function addMessageProvider(provider: string) {
    onChange({ ...draft, messageProvider: provider });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="mt-2" />}>
        <Plus />
        <Trans>Add trigger</Trans>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-auto">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={Boolean(draft.watch)}>
            <Clock />
            <Trans>On a schedule</Trans>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-[170px]">
            {SCHEDULE_PRESETS.map((freq) => (
              <DropdownMenuItem key={freq} onClick={() => addSchedule(freq)}>
                {freq === "Advanced" ? t`Advanced...` : cronFreqLabel(freq)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <span className="block" title={echoAvailable ? undefined : t`Echo not enabled`}>
          <DropdownMenuItem
            disabled={draft.messageProvider === "echo" || !echoAvailable}
            aria-describedby={echoAvailable ? undefined : echoDisabledReasonId}
            onClick={() => addMessageProvider("echo")}
          >
            <MessageSquare />
            <Trans>Echo message</Trans>
          </DropdownMenuItem>
          {!echoAvailable ? (
            <span id={echoDisabledReasonId} className="sr-only">
              <Trans>Echo not enabled</Trans>
            </span>
          ) : null}
        </span>

        <DropdownMenuItem
          disabled={Boolean(draft.watch) || draft.schedules.length > 0}
          onClick={() => onChange({ ...draft, watch: emptyWatchDraft() })}
        >
          <Eye />
          <Trans>When something changes</Trans>
        </DropdownMenuItem>

        {emailAvailable ? (
          <DropdownMenuItem
            disabled={Boolean(draft.emailSenders)}
            onClick={() => onChange({ ...draft, emailSenders: "owner" })}
          >
            <Mail />
            {t({ message: "Email", context: "routine trigger" })}
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuItem disabled={draft.githubEnabled} onClick={() => void addGithub()}>
          <GitBranch />
          <Trans>Git event</Trans>
        </DropdownMenuItem>

        <DropdownMenuItem disabled={draft.webhookEnabled} onClick={() => void addWebhook()}>
          <Globe />
          <Trans>Webhook</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
