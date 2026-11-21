export class ScheduleService {
  constructor({ runtimeClient, vault, notify = async () => {}, intervalMs = 5000 }) {
    this.runtime = runtimeClient;
    this.vault = vault;
    this.notify = notify;
    this.intervalMs = intervalMs;
    this.stopped = true;
    this.inFlight = null;
  }
  tick() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#tick().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async #tick() {
    const due = await this.runtime.request('schedule.tick');
    if (!due.ok) return;
    for (const event of due.result.events) {
      let apiKey;
      if (event.kind === 'agent-task') {
        try {
          const settings = await this.runtime.request('settings.get');
          const setting = settings.result?.settings?.find(item => item.id === event.binding.settingId);
          if (setting) apiKey = await this.vault.get(setting.credentialRef ?? setting.id);
        } catch {
          // The runtime records the missing credential as an instance failure.
        }
      }
      const result = await this.runtime.request('schedule.run', { id: event.id, modelCredential: apiKey ? { apiKey } : undefined });
      if (result.ok && result.result.event?.kind === 'reminder' && result.result.event.status === 'fired') {
        try { await this.notify(event.text); } catch { /* The persistent reminder remains available in the desktop. */ }
      }
    }
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const run = async () => {
      try { await this.tick(); } catch { /* Retry the next tick without replaying claimed instances. */ }
      if (!this.stopped) { this.timer = setTimeout(run, this.intervalMs); this.timer.unref?.(); }
    };
    void run();
  }
  async close() { this.stopped = true; clearTimeout(this.timer); await this.inFlight?.catch(() => {}); }
}
