import { Octokit } from '@octokit/rest';
import { mocked } from 'jest-mock';
import moment from 'moment-timezone';
import nock from 'nock';

import { listEC2Runners } from '../aws/runners';
import * as ghAuth from '../gh-auth/gh-auth';
import { createRunners } from '../scale-runners/scale-up';
import { adjust } from './pool';

const mockOctokit = {
  paginate: jest.fn(),
  checks: { get: jest.fn() },
  actions: {
    createRegistrationTokenForOrg: jest.fn(),
  },
  apps: {
    getOrgInstallation: jest.fn(),
  },
};

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => mockOctokit),
}));

jest.mock('./../aws/runners');
jest.mock('./../gh-auth/gh-auth');
jest.mock('./../scale-runners/scale-up');

const mocktokit = Octokit as jest.MockedClass<typeof Octokit>;
const mockedAppAuth = mocked(ghAuth.createGithubAppAuth, {
  shallow: false,
});
const mockedInstallationAuth = mocked(ghAuth.createGithubInstallationAuth, { shallow: false });
const mockCreateClient = mocked(ghAuth.createOctoClient, { shallow: false });
const mockListRunners = mocked(listEC2Runners);

const cleanEnv = process.env;

const ORG = 'my-org';
const MINIMUM_TIME_RUNNING = 15;

const ec2InstancesRegistered = [
  {
    instanceId: 'i-1',
    launchTime: new Date(),
    type: 'Org',
    owner: ORG,
  },
  {
    instanceId: 'i-2',
    launchTime: new Date(),
    type: 'Org',
    owner: ORG,
  },
  {
    instanceId: 'i-3',
    launchTime: new Date(),
    type: 'Org',
    owner: ORG,
  },
];

beforeEach(() => {
  nock.disableNetConnect();
  jest.resetModules();
  jest.clearAllMocks();
  process.env = { ...cleanEnv };
  process.env.GITHUB_APP_KEY_BASE64 = 'TEST_CERTIFICATE_DATA';
  process.env.GITHUB_APP_ID = '1337';
  process.env.GITHUB_APP_CLIENT_ID = 'TEST_CLIENT_ID';
  process.env.GITHUB_APP_CLIENT_SECRET = 'TEST_CLIENT_SECRET';
  process.env.RUNNERS_MAXIMUM_COUNT = '3';
  process.env.ENVIRONMENT = 'unit-test-environment';
  process.env.ENABLE_ORGANIZATION_RUNNERS = 'true';
  process.env.LAUNCH_TEMPLATE_NAME = 'lt-1';
  process.env.SUBNET_IDS = 'subnet-123';
  process.env.SSM_TOKEN_PATH = '/github-action-runners/default/runners/tokens';
  process.env.INSTANCE_TYPES = 'm5.large';
  process.env.INSTANCE_TARGET_CAPACITY_TYPE = 'spot';
  process.env.RUNNER_OWNER = ORG;
  process.env.RUNNER_BOOT_TIME_IN_MINUTES = MINIMUM_TIME_RUNNING.toString();

  const mockTokenReturnValue = {
    data: {
      token: '1234abcd',
    },
  };
  mockOctokit.actions.createRegistrationTokenForOrg.mockImplementation(() => mockTokenReturnValue);

  mockOctokit.paginate.mockImplementation(() => [
    {
      id: 1,
      name: 'i-1',
      os: 'linux',
      status: 'online',
      busy: false,
      labels: [],
    },
    {
      id: 2,
      name: 'i-2',
      os: 'linux',
      status: 'online',
      busy: true,
      labels: [],
    },
    {
      id: 3,
      name: 'i-3',
      os: 'linux',
      status: 'offline',
      busy: false,
      labels: [],
    },
  ]);

  mockListRunners.mockImplementation(async () => ec2InstancesRegistered);

  const mockInstallationIdReturnValueOrgs = {
    data: {
      id: 1,
    },
  };
  mockOctokit.apps.getOrgInstallation.mockImplementation(() => mockInstallationIdReturnValueOrgs);

  mockedAppAuth.mockResolvedValue({
    type: 'app',
    token: 'token',
    appId: 1,
    expiresAt: 'some-date',
  });
  mockedInstallationAuth.mockResolvedValue({
    type: 'token',
    tokenType: 'installation',
    token: 'token',
    createdAt: 'some-date',
    expiresAt: 'some-date',
    permissions: {},
    repositorySelection: 'all',
    installationId: 0,
  });

  mockCreateClient.mockResolvedValue(new mocktokit());
});

describe('Test simple pool.', () => {
  describe('With GitHub Cloud', () => {
    it('Top up pool with pool size 2 registered.', async () => {
      await expect(await adjust({ poolSize: 3 })).resolves;
      expect(createRunners).toHaveBeenCalledTimes(1);
      expect(createRunners).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ numberOfRunners: 2 }),
        expect.anything(),
      );
    });

    it('Should not top up if pool size is reached.', async () => {
      await expect(await adjust({ poolSize: 1 })).resolves;
      expect(createRunners).not.toHaveBeenCalled();
    });

    it('Should top up if pool size is not reached including a booting instance.', async () => {
      mockListRunners.mockImplementation(async () => [
        ...ec2InstancesRegistered,
        {
          instanceId: 'i-4-still-booting',
          launchTime: moment(new Date())
            .subtract(MINIMUM_TIME_RUNNING - 3, 'minutes')
            .toDate(),
          type: 'Org',
          owner: ORG,
        },
        {
          instanceId: 'i-5-orphan',
          launchTime: moment(new Date())
            .subtract(MINIMUM_TIME_RUNNING + 3, 'minutes')
            .toDate(),
          type: 'Org',
          owner: ORG,
        },
      ]);

      // 1 idle + 1 booting = 2, top up with 3 to match a pool of 5
      await expect(await adjust({ poolSize: 5 })).resolves;
      expect(createRunners).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ numberOfRunners: 3 }),
        expect.anything(),
      );
    });

    it('Should not top up if pool size is reached including a booting instance.', async () => {
      mockListRunners.mockImplementation(async () => [
        ...ec2InstancesRegistered,
        {
          instanceId: 'i-4-still-booting',
          launchTime: moment(new Date())
            .subtract(MINIMUM_TIME_RUNNING - 3, 'minutes')
            .toDate(),
          type: 'Org',
          owner: ORG,
        },
        {
          instanceId: 'i-5-orphan',
          launchTime: moment(new Date())
            .subtract(MINIMUM_TIME_RUNNING + 3, 'minutes')
            .toDate(),
          type: 'Org',
          owner: ORG,
        },
      ]);

      await expect(await adjust({ poolSize: 2 })).resolves;
      expect(createRunners).not.toHaveBeenCalled();
    });
  });

  describe('With GHES', () => {
    beforeEach(() => {
      process.env.GHES_URL = 'https://github.enterprise.something';
    });

    it('Top up if the pool size is set to 5', async () => {
      await expect(await adjust({ poolSize: 5 })).resolves;
      // 1 idle, top up with 4 to match a pool of 5
      expect(createRunners).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ numberOfRunners: 4 }),
        expect.anything(),
      );
    });
  });
});
