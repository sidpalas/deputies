import { Template, type ConnectionOptions, type TemplateInfo } from '@superserve/sdk';

const templateName = process.env.SUPERSERVE_TEMPLATE ?? 'deputies';
const image = process.env.SUPERSERVE_IMAGE ?? 'ghcr.io/sidpalas/deputies-daytona-sandbox:latest';

async function main(): Promise<void> {
  if (templateName.startsWith('superserve/')) {
    throw new Error('SUPERSERVE_TEMPLATE must name a team template; the superserve/ prefix is reserved');
  }
  const connection = superserveConnection();
  const existing = (await Template.list({ ...connection, namePrefix: templateName })).find(
    (template) => template.name === templateName,
  );

  let template: Template;
  if (!existing) {
    template = await Template.create({
      ...connection,
      name: templateName,
      from: image,
      vcpu: positiveInteger(process.env.SUPERSERVE_TEMPLATE_VCPU, 2, 'SUPERSERVE_TEMPLATE_VCPU'),
      memoryMib: positiveInteger(process.env.SUPERSERVE_TEMPLATE_MEMORY_MIB, 2048, 'SUPERSERVE_TEMPLATE_MEMORY_MIB'),
      diskMib: positiveInteger(process.env.SUPERSERVE_TEMPLATE_DISK_MIB, 8192, 'SUPERSERVE_TEMPLATE_DISK_MIB'),
    });
    console.log(`Created Superserve template ${templateName} from ${image}`);
  } else {
    template = await Template.connect(existing.id, connection);
    if (isBuilding(existing)) {
      console.log(`Superserve template ${templateName} is already building; waiting for it`);
    } else {
      await template.rebuild();
      template = await Template.connect(existing.id, connection);
      console.log(`Rebuilding Superserve template ${templateName} from its pinned image reference`);
    }
  }

  const ready = await template.waitUntilReady({
    onLog: (event) => {
      if (event.text) process.stdout.write(event.text);
    },
  });
  console.log(`Superserve template ${ready.name} is ready (${ready.id})`);
}

function superserveConnection(): ConnectionOptions {
  const apiKey = process.env.SUPERSERVE_API_KEY;
  if (!apiKey) throw new Error('SUPERSERVE_API_KEY is required');
  return {
    apiKey,
    ...(process.env.SUPERSERVE_BASE_URL ? { baseUrl: process.env.SUPERSERVE_BASE_URL } : {}),
  };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function isBuilding(template: TemplateInfo): boolean {
  return template.status === 'pending' || template.status === 'building';
}

await main();
