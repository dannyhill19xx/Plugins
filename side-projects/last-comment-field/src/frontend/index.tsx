import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  ButtonGroup,
  Checkbox,
  Heading,
  Label,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Stack,
  Text,
  Textfield,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import type { Settings } from '../core';
import type { BackfillState } from '../backfill';

/** Typed resolver call. Without invoke metadata the bridge returns the plain body. */
const call = async <T,>(key: string, payload?: Record<string, unknown>): Promise<T> =>
  (await invoke(key, payload)) as T;

const STATUS_APPEARANCE = {
  running: 'inprogress',
  done: 'success',
  failed: 'removed',
  cancelled: 'default',
} as const;

function SettingsForm() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [lengthInput, setLengthInput] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<Settings>('getSettings').then((s) => {
      setSettings(s);
      setLengthInput(String(s.maxLength));
    });
  }, []);

  if (!settings) return <Text>Loading settings…</Text>;

  const update = (patch: Partial<Settings>) => {
    setSettings({ ...settings, ...patch });
    setSaved(false);
  };

  const save = async () => {
    setError(null);
    try {
      const stored = await call<Settings>('saveSettings', { ...settings, maxLength: Number(lengthInput) });
      setSettings(stored);
      setLengthInput(String(stored.maxLength));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Stack space="space.200">
      <Heading size="medium">Field content</Heading>
      <Stack space="space.050">
        <Label labelFor="max-length">Maximum length (20–255 characters)</Label>
        <Textfield
          id="max-length"
          type="number"
          value={lengthInput}
          onChange={(e) => {
            setLengthInput(e.target.value);
            setSaved(false);
          }}
        />
      </Stack>
      <Checkbox
        label="Show comment date"
        isChecked={settings.showDate}
        onChange={(e) => update({ showDate: e.target.checked })}
      />
      <Checkbox
        label="Show comment author"
        isChecked={settings.showAuthor}
        onChange={(e) => update({ showAuthor: e.target.checked })}
      />
      <Checkbox
        label="Include restricted comments and JSM internal notes"
        isChecked={settings.includeRestricted}
        onChange={(e) => update({ includeRestricted: e.target.checked })}
      />
      {settings.includeRestricted && (
        <SectionMessage appearance="warning" title="Restricted text becomes visible">
          <Text>
            The field is shown to everyone who can see the issue, including JSM customers if you add it to the
            portal. Comments limited to a group or role, and internal notes, will be visible to all of them.
          </Text>
        </SectionMessage>
      )}
      {error && (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      )}
      <ButtonGroup>
        <Button appearance="primary" onClick={save}>
          Save
        </Button>
      </ButtonGroup>
      {saved && (
        <SectionMessage appearance="success">
          <Text>Saved. New comments use these settings; run a backfill below to apply them to existing issues.</Text>
        </SectionMessage>
      )}
    </Stack>
  );
}

function BackfillPanel() {
  const [state, setState] = useState<BackfillState | null | undefined>(undefined);
  const refresh = () => call<BackfillState | null>('getBackfill').then(setState);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  if (state === undefined) return <Text>Loading backfill status…</Text>;

  const running = state?.status === 'running';
  const progress = state && state.projectsTotal > 0 ? state.projectsDone / state.projectsTotal : 0;

  return (
    <Stack space="space.200">
      <Heading size="medium">Existing issues</Heading>
      <Text>Recompute the field for every issue on the site. Runs in the background, project by project.</Text>
      {state ? (
        <Stack space="space.100">
          <Lozenge appearance={STATUS_APPEARANCE[state.status]}>{state.status}</Lozenge>
          {running && <ProgressBar value={progress} ariaLabel="Backfill progress" />}
          <Text>
            Projects: {state.projectsDone} / {state.projectsTotal}. Issues processed: {state.issuesProcessed}. Started{' '}
            {new Date(state.startedAt).toLocaleString()}.
          </Text>
          {state.error && (
            <SectionMessage appearance="error">
              <Text>{state.error}</Text>
            </SectionMessage>
          )}
        </Stack>
      ) : (
        <Text>Not run yet.</Text>
      )}
      <ButtonGroup>
        <Button
          appearance="primary"
          isDisabled={running}
          onClick={() => call<BackfillState>('startBackfill').then(setState)}
        >
          Run backfill
        </Button>
        <Button isDisabled={!running} onClick={() => call<BackfillState | null>('cancelBackfill').then(setState)}>
          Cancel
        </Button>
      </ButtonGroup>
    </Stack>
  );
}

const App = () => (
  <Stack space="space.400">
    <SettingsForm />
    <BackfillPanel />
  </Stack>
);

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
