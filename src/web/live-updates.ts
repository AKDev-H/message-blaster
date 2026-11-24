import type { ServerResponse } from "node:http";

const PROGRESS_CHECK_MS = 500;
const HEARTBEAT_MS = 15_000;

export class LiveUpdates {
    readonly #subscribers = new Map<ServerResponse, () => boolean>();
    readonly #blocked = new Set<ServerResponse>();
    readonly #pending = new Set<ServerResponse>();
    #version: number | undefined;
    #revision = 0;
    #dirty = true;
    #queued = false;
    #closing = false;
    #timers: NodeJS.Timeout[] = [];

    constructor(
        private readonly dataVersion: () => number,
        private readonly snapshot: () => unknown,
    ) {}

    get revision(): number {
        return this.#revision;
    }

    start(): void {
        const keepAlive = () => {
            this.revalidate();
            for (const client of this.#subscribers.keys())
                this.write(client, ": keep-alive\n\n", false);
        };
        this.#timers = [
            setInterval(() => this.publishSafely(), PROGRESS_CHECK_MS).unref(),
            setInterval(keepAlive, HEARTBEAT_MS).unref(),
        ];
    }

    changed(): void {
        if (this.#closing) return;
        this.#dirty = true;
        if (this.#queued) return;
        this.#queued = true;
        queueMicrotask(() => {
            this.#queued = false;
            this.publishSafely();
        });
    }

    subscribe(res: ServerResponse, sessionActive: () => boolean): void {
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        this.#subscribers.set(res, sessionActive);
        res.on("close", () => this.forget(res));
        this.write(res, `retry: 2000\n${this.event()}`);
    }

    close(): void {
        this.#closing = true;
        this.#timers.forEach(clearInterval);
        for (const client of this.#subscribers.keys()) client.end();
    }

    revalidate(): void {
        for (const [client, sessionActive] of this.#subscribers) {
            try {
                if (sessionActive()) continue;
            } catch {
            }
            this.forget(client);
            client.end();
        }
    }

    private publishSafely(): void {
        try {
            this.publish();
        } catch (error) {
            console.error('Campaign progress update failed', error);
            this.#dirty = true;
        }
    }

    private publish(): void {
        if (this.#closing || this.#subscribers.size === 0) return;
        const version = this.dataVersion();
        if (!this.#dirty && version === this.#version) return;
        this.revalidate();
        this.#version = version;
        this.#dirty = false;
        this.#revision += 1;
        const event = this.event();
        for (const client of this.#subscribers.keys())
            this.write(client, event);
    }

    private event(): string {
        return `data: ${JSON.stringify(this.snapshot())}\n\n`;
    }

    private write(
        client: ServerResponse,
        event: string,
        isUpdate = true,
    ): void {
        if (this.#blocked.has(client)) {
            if (isUpdate) this.#pending.add(client);
            return;
        }
        if (client.write(event)) return;
        this.#blocked.add(client);
        client.once("drain", () => this.onDrain(client));
    }

    private onDrain(client: ServerResponse): void {
        this.#blocked.delete(client);
        if (!this.#pending.delete(client) || this.#closing) return;
        try {
            const sessionActive = this.#subscribers.get(client);
            if (sessionActive?.()) this.write(client, this.event());
            else client.end();
        } catch {
            client.destroy();
        }
    }

    private forget(client: ServerResponse): void {
        this.#subscribers.delete(client);
        this.#blocked.delete(client);
        this.#pending.delete(client);
    }
}
