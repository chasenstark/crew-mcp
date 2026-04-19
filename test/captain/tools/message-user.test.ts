import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptainSession } from '../../../src/captain/session.js';
import { dispatchMessageUser } from '../../../src/captain/tools/message-user.js';

describe('dispatchMessageUser', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-msg-user-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('appends a SessionAssistantMessage and returns sent', () => {
    const session = CaptainSession.create({ projectRoot: root });
    const result = dispatchMessageUser(session, { text: 'halfway done with task 3' });
    expect(result.status).toBe('sent');
    expect(result.timestamp).toBeTruthy();
    const messages = session.getMessages();
    const last = messages[messages.length - 1];
    expect(last.role).toBe('assistant');
    if (last.role === 'assistant') {
      expect(last.text).toBe('halfway done with task 3');
    }
  });

  it('each call produces its own message (multiple messages per turn)', () => {
    const session = CaptainSession.create({ projectRoot: root });
    dispatchMessageUser(session, { text: 'first' });
    dispatchMessageUser(session, { text: 'second' });
    const assistantMessages = session.getMessages().filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(2);
  });
});
