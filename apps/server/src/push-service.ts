import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import webpush, { type PushSubscription } from 'web-push';

type Stored = Record<string, PushSubscription>;
export class PushService {
  readonly publicKey = process.env.RAC_VAPID_PUBLIC_KEY;
  private readonly privateKey = process.env.RAC_VAPID_PRIVATE_KEY;
  private readonly file = process.env.RAC_PUSH_SUBSCRIPTIONS_FILE ?? '.data/push-subscriptions.json';
  constructor() { if (this.publicKey && this.privateKey) webpush.setVapidDetails('mailto:admin@localhost', this.publicKey, this.privateKey); }
  get enabled() { return Boolean(this.publicKey && this.privateKey); }
  async subscribe(subscription: PushSubscription) { if (!this.enabled || !this.valid(subscription)) return false; const all = await this.read(); all[subscription.endpoint] = subscription; await this.write(all); return true; }
  async notify(title: string, body: string, tag: string, url = '/') { if (!this.enabled) return; const all = await this.read(); await Promise.all(Object.values(all).map(async subscription => { try { await webpush.sendNotification(subscription, JSON.stringify({ title, body, tag, url })); } catch (error) { const status = (error as { statusCode?: number }).statusCode; if (status === 404 || status === 410) { delete all[subscription.endpoint]; await this.write(all); } } })); }
  private valid(value: PushSubscription): value is PushSubscription { return typeof value?.endpoint === 'string' && value.endpoint.startsWith('https://') && typeof value.keys?.p256dh === 'string' && typeof value.keys.auth === 'string'; }
  private async read(): Promise<Stored> { return JSON.parse(await readFile(this.file, 'utf8').catch(() => '{}')) as Stored; }
  private async write(value: Stored) { await mkdir(dirname(this.file), { recursive: true }); const next = `${this.file}.next`; await writeFile(next, JSON.stringify(value), { mode: 0o600 }); await rename(next, this.file); }
}
