import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelConnectionTestResult } from "@rakazo/contracts";
import { modelHeadersInput } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Check, Minus, X } from "lucide-react";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import type { ModelSettingsState } from "./use-model-settings";

type TestFields = Pick<
  ModelSettingsState,
  "apiKey" | "apiProtocol" | "baseUrl" | "busy" | "credential" | "headerRows" | "modelId"
>;

/**
 * Tests the server as the form stands, before or after saving: lists its models, then asks the
 * chosen model for a one-word reply. Blank key fields use the saved connection's key.
 */
export function CompatibleConnectionTest({
  apiKey,
  apiProtocol,
  baseUrl,
  busy,
  credential,
  headerRows,
  modelId,
}: TestFields) {
  const { t } = useLingui();
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<{
    fields: string;
    result?: ModelConnectionTestResult;
    error?: string;
  } | null>(null);
  const fields = JSON.stringify([baseUrl.trim(), apiKey, apiProtocol, headerRows, modelId.trim()]);
  // A result describes the fields it ran with; editing any of them clears it.
  const shown = outcome?.fields === fields ? outcome : null;

  async function runTest() {
    setTesting(true);
    setOutcome(null);
    try {
      // Throws on an invalid header row, which the header fields already point out.
      const headers = modelHeadersInput(headerRows);
      const result = await rpc.models.testOpenAiCompatible({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        apiProtocol,
        headers,
        modelId: modelId.trim() || undefined,
        credentialId: credential?.id,
      });
      setOutcome({ fields, result });
    } catch (error) {
      setOutcome({ fields, error: errorText(error, t`Could not run the test`) });
    } finally {
      setTesting(false);
    }
  }

  const stepName = (step: "models" | "chat") =>
    step === "models" ? t`List models` : t`Model reply`;
  const seconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

  return (
    <div className="mt-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy || testing || !baseUrl.trim()}
        onClick={() => void runTest()}
      >
        {testing ? (
          <Trans>Testing… (a slow model can take a minute)</Trans>
        ) : (
          <Trans>Test connection</Trans>
        )}
      </Button>
      {shown?.error ? (
        <p className="mt-2 text-body-sm text-destructive" role="alert">
          {shown.error}
        </p>
      ) : null}
      {shown?.result ? (
        <div
          className="mt-3 space-y-2 rounded-lg border border-border p-3 text-body-sm"
          role={shown.result.ok ? "status" : "alert"}
        >
          <p
            className={
              shown.result.ok ? "font-medium text-success" : "font-medium text-destructive"
            }
          >
            {shown.result.ok ? <Trans>Connection works.</Trans> : <Trans>Connection failed.</Trans>}
          </p>
          <ul className="space-y-1.5">
            {shown.result.steps.map((step) => (
              <li key={step.step} className="flex items-start gap-2">
                {step.skipped ? (
                  <Minus
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                    aria-label={t`Skipped`}
                  />
                ) : step.ok ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label={t`Passed`} />
                ) : (
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-label={t`Failed`} />
                )}
                <span>
                  <span className="text-foreground">{stepName(step.step)}</span>
                  {step.skipped ? null : (
                    <span className="text-muted-foreground"> · {seconds(step.durationMs)}</span>
                  )}
                  <span className="block text-muted-foreground">{step.message}</span>
                </span>
              </li>
            ))}
          </ul>
          {shown.result.reply !== undefined ? (
            <p className="text-muted-foreground">
              <Trans>Reply:</Trans>{" "}
              <span className="text-foreground">{shown.result.reply || t`(empty)`}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
