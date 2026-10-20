// Operator-only connection. Never prints credentials, account identifiers or raw errors.
import { readFileSync, existsSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GcloudResolutionError, execGcloudSync } from './gcloud-command.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGION = 'asia-northeast3';
const PREFIX = 'investing-toss-';
const EGRESS_ADDRESS = 'investing-egress';
const SAFE_FAILURE =
  '토스 연결 작업이 중단되었습니다. 원문 로그 대신 정제된 작업 오류 코드와 개인 계정 권한을 확인하세요.';
export class ConnectionError extends Error {}

export function loadConfiguration(root = ROOT) {
  try {
    if (!existsSync(resolve(root, '.local/deployment-account.md'))) throw new Error();
    const config = JSON.parse(readFileSync(resolve(root, '.local/deployment.json'), 'utf8'));
    const owner = JSON.parse(readFileSync(resolve(root, '.local/owner-access.json'), 'utf8'));
    if (
      config?.personalOnly !== true ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.account ?? '') ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.project ?? '') ||
      owner?.project !== config.project ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(owner.userId ?? '')
    )
      throw new Error();
    return { account: config.account, project: config.project, userId: owner.userId };
  } catch {
    throw new ConnectionError('개인 배포 설정과 동일 프로젝트 소유자 파일을 확인하세요.');
  }
}

export function executeGcloud(argv, options) {
  return execGcloudSync(argv, {
    ...options,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  });
}

export function connectToss(
  config,
  { execute = false, runner = executeGcloud, progress = console.log } = {},
) {
  const cloud = (args, { input, timeout = 60_000 } = {}) => {
    try {
      return String(
        runner(
          [
            ...args,
            `--account=${config.account}`,
            `--project=${config.project}`,
            `--billing-project=${config.project}`,
            '--quiet',
          ],
          { input, timeout },
        ),
      );
    } catch (error) {
      // Resolution errors are static, credential-free messages that tell the operator what to fix.
      if (error instanceof GcloudResolutionError) throw new ConnectionError(error.message);
      throw new ConnectionError(SAFE_FAILURE);
    }
  };
  const version = (name, required = true) => {
    const response = cloud([
      'secrets',
      'versions',
      'list',
      PREFIX + name,
      '--filter=state=ENABLED',
      '--sort-by=~createTime',
      '--limit=1',
      '--format=value(name)',
    ]).trim();
    if (!response && !required) return null;
    const value = response.split('/').at(-1);
    if (!/^\d+$/.test(value ?? ''))
      throw new ConnectionError('필요한 활성 비밀 버전이 없습니다. 키 저장 상태를 확인하세요.');
    return value;
  };
  progress('[3/5] 사전 확인 중');
  const clientId = version('client-id');
  const clientSecret = version('client-secret');
  let ownerVersion = version('owner-user-id', false);
  if (ownerVersion) {
    const existingOwner = cloud([
      'secrets',
      'versions',
      'access',
      ownerVersion,
      `--secret=${PREFIX}owner-user-id`,
    ]);
    if (existingOwner !== config.userId)
      throw new ConnectionError(
        '저장된 소유자 연결이 일치하지 않습니다. 자동으로 덮어쓰지 않습니다.',
      );
  }
  const ready = cloud([
    'run',
    'services',
    'describe',
    'ai-investing',
    `--region=${REGION}`,
    '--format=value(status.latestReadyRevisionName,status.latestCreatedRevisionName)',
  ])
    .trim()
    .split(/\s+/);
  if (ready.length !== 2 || !ready[0] || ready[0] !== ready[1])
    throw new ConnectionError('서비스의 최신 배포가 준비될 때까지 기다려 주세요.');
  const image = cloud([
    'run',
    'services',
    'describe',
    'ai-investing',
    `--region=${REGION}`,
    '--format=value(spec.template.spec.containers[0].image)',
  ]).trim();
  const imagePrefix = `${REGION}-docker.pkg.dev/${config.project}/ai-investing/app@sha256:`;
  if (!image.startsWith(imagePrefix) || !/^[a-f0-9]{64}$/.test(image.slice(imagePrefix.length))) {
    throw new ConnectionError('검증된 개인 프로젝트의 불변 이미지가 아닙니다.');
  }
  const ip = cloud([
    'compute',
    'addresses',
    'describe',
    EGRESS_ADDRESS,
    `--region=${REGION}`,
    '--format=value(address)',
  ]).trim();
  if (!isIPv4(ip))
    throw new ConnectionError(
      '고정 출구 IP를 확인할 수 없습니다. Terraform 인프라 적용 상태를 확인하세요.',
    );
  progress(`  토스 허용 IP 관리에 ${ip} 주소가 등록되어 있어야 합니다.`);
  if (!execute) {
    progress('사전 확인을 마쳤습니다. 다음 단계:');
    progress('[4/5] 계좌 연결을 실행하세요: node scripts/connect-toss.mjs --execute');
    return { preflight: true, executed: false };
  }
  if (!ownerVersion) {
    cloud(['secrets', 'versions', 'add', `${PREFIX}owner-user-id`, '--data-file=-'], {
      input: config.userId,
    });
    ownerVersion = version('owner-user-id');
    const storedOwner = cloud([
      'secrets',
      'versions',
      'access',
      ownerVersion,
      `--secret=${PREFIX}owner-user-id`,
    ]);
    if (storedOwner !== config.userId)
      throw new ConnectionError('소유자 저장 확인에 실패했습니다.');
  }
  progress('[4/5] 고정 IP 경유 계좌 확인 작업 실행 중');
  try {
    cloud(
      [
        'run',
        'jobs',
        'deploy',
        'investing-toss-setup',
        `--region=${REGION}`,
        `--image=${image}`,
        `--service-account=investing-setup@${config.project}.iam.gserviceaccount.com`,
        '--command=node',
        '--args=--import,tsx,src/server/toss-setup.ts',
        `--set-env-vars=NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${config.project}`,
        `--set-secrets=TOSS_CLIENT_ID=${PREFIX}client-id:${clientId},TOSS_CLIENT_SECRET=${PREFIX}client-secret:${clientSecret}`,
        '--network=investing-network',
        '--subnet=investing-subnet',
        '--vpc-egress=all-traffic',
        '--max-retries=0',
        '--tasks=1',
        '--parallelism=1',
        '--task-timeout=60s',
        '--cpu=1',
        '--memory=512Mi',
        '--execute-now',
        '--wait',
      ],
      { timeout: 180_000 },
    );
  } catch {
    throw new ConnectionError(
      `계좌 확인 작업이 실패했습니다. 토스 허용 IP에 ${ip} 주소가 등록되어 있는지 확인한 뒤, 작업 실행 기록의 정제된 오류 코드를 확인하세요.`,
    );
  }
  const accountSeq = version('account-seq');
  progress('확인된 비밀 버전으로 서비스 연결 중');
  cloud(
    [
      'run',
      'services',
      'update',
      'ai-investing',
      `--region=${REGION}`,
      `--update-secrets=TOSS_CLIENT_ID=${PREFIX}client-id:${clientId},TOSS_CLIENT_SECRET=${PREFIX}client-secret:${clientSecret},TOSS_ACCOUNT_SEQ=${PREFIX}account-seq:${accountSeq},TOSS_OWNER_USER_ID=${PREFIX}owner-user-id:${ownerVersion}`,
    ],
    { timeout: 180_000 },
  );
  progress('서비스 연결을 마쳤습니다. 다음 단계:');
  progress('[5/5] 서비스에 로그인해 내 자산 페이지에서 실제 보유 내역이 보이는지 확인하세요.');
  return { preflight: true, executed: true };
}

export function main(args = process.argv.slice(2)) {
  try {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--execute')) {
      throw new ConnectionError('Usage: node scripts/connect-toss.mjs [--execute]');
    }
    connectToss(loadConfiguration(), { execute: args[0] === '--execute' });
    return 0;
  } catch (error) {
    console.error(error instanceof ConnectionError ? error.message : SAFE_FAILURE);
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = main();
