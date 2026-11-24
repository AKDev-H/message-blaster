import { performance } from 'node:perf_hooks';
import ExcelJS from 'exceljs';
import { openDatabase } from '../src/database/connection.js';
import { prepareRows } from '../src/services/campaign/prepare-rows.js';
import { readExcel, readExcelChannels } from '../src/services/excel/read.js';
import { Store, type PreparedRow } from '../src/store/index.js';
import type { CampaignChannel } from '../src/types/index.js';

const SIZES = [1_000, 5_000];
const RUNS = 15;
const CHANNELS: CampaignChannel[] = ['gmail', 'whatsapp'];
const env = { DEFAULT_COUNTRY: 'MY', ATTACHMENTS_DIR: 'storage/bench-missing' };

async function workbook(size: number): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Clients');
    sheet.addRow(['Client Name', 'Email Address', 'Phone Number', 'Subject', 'Message', 'PDF Filename', 'Consent Status', 'Campaign ID']);
    for (let index = 0; index < size; index += 1) {
        sheet.addRow([`Client ${index}`, `c${index}@example.com`, `+60123${String(index).padStart(6, '0')}`, 'Hi', '', '', 'Opted In', '']);
    }
    return Buffer.from(await book.xlsx.writeBuffer());
}

async function median(action: () => unknown | Promise<unknown>): Promise<number> {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        await action();
        times.push(performance.now() - started);
    }
    return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
}

async function prepare(store: Store, id: string, channel: CampaignChannel, rows: Awaited<ReturnType<typeof readExcel>>): Promise<PreparedRow[]> {
    return prepareRows(store, env, id, rows, 'Hello {{client_name}}', channel);
}

async function measure(size: number) {
    const source = await workbook(size);
    using db = openDatabase(':memory:');
    const store = new Store(db);
    const parsed = await readExcelChannels(source, CHANNELS);
    store.createCampaignGroup({
        slug: 'bench', name: 'bench', shared: { script: 'Hello', subject: 'Hi', attachment: '' },
        campaigns: await Promise.all(CHANNELS.map(async channel => ({
            id: `bench-${channel}`, channel, rows: await prepare(store, `bench-${channel}`, channel, parsed.get(channel)!),
        }))),
    });
    for (let index = 0; index < 50; index += 1) store.importCampaign(`filler-${index}`, (await prepare(store, `filler-${index}`, 'gmail', parsed.get('gmail')!.slice(0, 20))), false, 'gmail');
    db.prepare("UPDATE messages SET status = 'SENT' WHERE campaign_id = 'bench-gmail' AND row_number % 3 = 0").run();
    const group = store.campaignGroup('bench');

    return {
        recipients: size,
        list: await median(() => store.listGroupPage({ page: 1, pageSize: 10 })),
        'detail (group + channel page)': await median(() => {
            const members = store.groupMembers(group);
            return [store.groupMetrics(group, members), members.map(member => store.memberMetrics(member.id)), store.listMessagePage('bench-gmail', 1, 25)];
        }),
        'parse once per channel': await median(() => Promise.all(CHANNELS.map(channel => readExcel(source, channel)))),
        'parse once for both': await median(() => readExcelChannels(source, CHANNELS)),
        'live snapshot': await median(() => store.listActiveCampaignIds()),
    };
}

const results = [];
for (const size of SIZES) results.push(await measure(size));
console.log(`Median of ${RUNS} runs, milliseconds`);
console.table(results.map(result => Object.fromEntries(Object.entries(result).map(([key, value]) => [key, key === 'recipients' ? value : Number(value.toFixed(2))]))));
