import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { get } from 'src/config';
import { Organization, Team } from 'src/typeorm';
import { ComponentReconcile } from 'src/typeorm/component-reconcile.entity';
import { Component } from 'src/typeorm/component.entity';
import { EnvironmentReconcile } from 'src/typeorm/environment-reconcile.entity';
import { Environment } from 'src/typeorm/environment.entity';
import { S3Handler } from 'src/utilities/s3Handler';
import {
  And,
  Any,
  Equal,
  FindOperator,
  In,
  IsNull,
  Like,
  Not,
  Raw,
} from 'typeorm';
import { Repository } from 'typeorm/repository/Repository';
import { ComponentReconcileWrap } from './dtos/componentAudit.dto';
import { EnvironmentReconcileWrap } from './dtos/environmentAudit.dto';
import {
  CreateComponentReconciliationDto,
  CreateEnvironmentReconciliationDto,
  CreateErrorEnvironmentReconciliationDto,
  UpdateComponentReconciliationDto,
  UpdateEnvironmentReconciliationDto,
} from './dtos/reconciliation.dto';
import { Mapper } from './mapper';

@Injectable()
export class ReconciliationService {
  private readonly s3h = S3Handler.instance();
  private readonly config = get();
  private readonly ckEnvironment = this.config.environment;
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectRepository(EnvironmentReconcile)
    private readonly envReconRepo: Repository<EnvironmentReconcile>,
    @InjectRepository(ComponentReconcile)
    private readonly compReconRepo: Repository<ComponentReconcile>
  ) {}

  async createEnvRecon(
    org: Organization,
    team: Team,
    env: Environment,
    createEnv: CreateEnvironmentReconciliationDto
  ): Promise<EnvironmentReconcile> {
    return this.envReconRepo.save({
      startDateTime: createEnv.startDateTime,
      environment: env,
      team,
      status: 'initializing',
      organization: org,
      dag: createEnv.components,
      gitSha: '',
      errorMessage: createEnv.errorMessage || null,
    });
  }

  async createErrorEnvRecon(
    org: Organization,
    team: Team,
    env: Environment,
    createEnv: CreateErrorEnvironmentReconciliationDto
  ): Promise<EnvironmentReconcile> {
    return this.envReconRepo.save({
      startDateTime: createEnv.startDateTime,
      environment: env,
      team,
      status: createEnv.status,
      organization: org,
      dag: createEnv.components,
      gitSha: '',
      errorMessage: createEnv.errorMessage || null,
      endDateTime: createEnv.endDateTime,
      estimatedCost: createEnv.estimatedCost,
    });
  }

  async updateEnvRecon(
    envRecon: EnvironmentReconcile,
    mergeRecon: UpdateEnvironmentReconciliationDto
  ): Promise<EnvironmentReconcile> {
    this.envReconRepo.merge(envRecon, mergeRecon);

    return this.envReconRepo.save(envRecon);
  }

  async getEnvReconByReconcileId(
    org: {
      id: number;
    },
    reconcileId: number,
    withEnv: boolean = false
  ) {
    return this.envReconRepo.findOne({
      where: {
        reconcileId,
        organization: {
          id: org.id,
        },
      },
      relations: {
        environment: withEnv,
      },
    });
  }

  async getEnvReconByEnv(org: Organization, env: Environment) {
    return this.envReconRepo.findOne({
      where: {
        environment: {
          id: env.id,
        },
        organization: {
          id: org.id,
        },
      },
      order: {
        startDateTime: -1,
      },
    });
  }

  async getEnvReconStatusBySHA(org: Organization, gitSha: string) {
    return this.envReconRepo.findOne({
      where: {
        gitSha: Equal(gitSha),
        organization: {
          id: Equal(org.id),
        },
      },
    });
  }

  async getEnvReconStatusByName(
    org: Organization,
    teamName: string,
    envName: string
  ) {
    return this.envReconRepo.findOne({
      where: {
        organization: {
          id: Equal(org.id),
        },
        team: {
          name: teamName,
        },
        environment: {
          name: envName,
        },
      },
    });
  }

  async getSkippedEnvironments(
    org: Organization,
    team: Team,
    env: Environment,
    ignoreReconcileIds: number[]
  ) {
    return this.envReconRepo.find({
      where: {
        endDateTime: IsNull(),
        status: Not(Equal('skipped_reconcile')),
        reconcileId: Not(In(ignoreReconcileIds)),
        team: {
          id: team.id,
        },
        organization: {
          id: org.id,
        },
        environment: {
          id: env.id,
        },
      },
    });
  }

  async bulkUpdateEnvironmentEntries(
    entries: EnvironmentReconcile[],
    status: string
  ) {
    if (entries.length > 0) {
      const newEntries = entries.map((entry) => ({
        ...entry,
        status,
      })) as any;

      this.logger.log({
        message: 'updating skipped workflows',
        environment: entries[0].environment,
      });

      await this.envReconRepo.save(newEntries);
    }
  }

  async createCompRecon(
    org: Organization,
    envRecon: EnvironmentReconcile,
    comp: Component,
    createComp: CreateComponentReconciliationDto
  ): Promise<ComponentReconcile> {
    return this.compReconRepo.save({
      component: comp,
      status: createComp.status || 'initializing',
      organization: org,
      startDateTime: createComp.startDateTime,
      environmentReconcile: envRecon,
    });
  }

  async updateCompRecon(
    compRecon: ComponentReconcile,
    mergeRecon: UpdateComponentReconciliationDto
  ): Promise<ComponentReconcile> {
    this.compReconRepo.merge(compRecon, mergeRecon);

    return this.compReconRepo.save(compRecon);
  }

  async findCompReconById(
    org: Organization,
    reconcileId: number,
    withEnvRecon: boolean = false,
    withComponent: boolean = false
  ): Promise<ComponentReconcile> {
    return this.compReconRepo.findOne({
      where: {
        reconcileId,
        organization: {
          id: org.id,
        },
      },
      relations: {
        environmentReconcile: withEnvRecon,
        component: withComponent,
      },
    });
  }

  async getCompReconByComponent(
    org: Organization,
    comp: Component
  ): Promise<ComponentReconcile> {
    return this.compReconRepo.findOne({
      where: {
        component: {
          id: Equal(comp.id),
        },
        organization: {
          id: org.id,
        },
      },
      order: {
        startDateTime: -1,
      },
    });
  }

  async getLatestCompReconByComponentIds(
    org: Organization,
    compIds: number[]
  ): Promise<ComponentReconcile[]> {
    const latestCompRecon = this.compReconRepo
      .createQueryBuilder('ccr')
      .select('MAX(ccr.startDateTime)')
      .where('ccr.componentId = cr.componentId');
    return this.compReconRepo
      .createQueryBuilder('cr')
      .select(
        'cr.id as reconcileId, cr.componentId as compId, cr.environmentReconcileReconcileId as envReconId, cr.*'
      )
      .where(
        `cr.organizationId = :orgId and cr.componentId IN (:compIds) and cr.startDateTime = (${latestCompRecon.getQuery()})`
      )
      .setParameters({
        orgId: org.id,
        compIds: compIds,
      })
      .execute();
  }

  async getSkippedComponents(
    org: Organization,
    envRecon: EnvironmentReconcile,
    comp: Component,
    ignoreReconcileIds: number[]
  ) {
    return await this.compReconRepo.find({
      where: {
        component: {
          id: Equal(comp.id),
        },
        endDateTime: IsNull(),
        status: Not(Equal('skipped_reconcile')),
        reconcileId: Not(In(ignoreReconcileIds)),
        environmentReconcile: {
          reconcileId: Equal(envRecon.reconcileId),
        },
        organization: {
          id: Equal(org.id),
        },
      },
    });
  }

  async bulkUpdateComponentEntries(
    entries: ComponentReconcile[],
    status: string
  ) {
    if (entries.length > 0) {
      const newEntries = entries.map((entry) => ({
        ...entry,
        status,
      })) as any;

      await this.compReconRepo.save(newEntries);
    }
  }

  async getComponentAuditList(
    org: Organization,
    comp: Component
  ): Promise<ComponentReconcileWrap[]> {
    const components = await this.compReconRepo.find({
      where: {
        component: {
          id: comp.id,
        },
        organization: {
          id: org.id,
        },
      },
      order: {
        startDateTime: -1,
      },
    });

    return Mapper.getComponentAuditList(components);
  }

  async getEnvironmentAuditList(
    org: Organization,
    env: Environment
  ): Promise<EnvironmentReconcileWrap[]> {
    const environments = await this.envReconRepo.find({
      where: {
        environment: {
          id: env.id,
        },
        organization: {
          id: org.id,
        },
      },
    });

    return Mapper.getEnvironmentAuditList(environments);
  }

  async getLatestNonValidationErrorRec(org: Organization, env: Environment) {
    return this.envReconRepo.findOne({
      where: {
        environment: {
          id: Equal(env.id),
        },
        organization: {
          id: Equal(org.id),
        },
        status: Not(Equal('validation_failed')),
      },
      order: {
        endDateTime: -1,
      },
    });
  }

  async getLogs(
    org: Organization,
    team: string,
    environment: Environment,
    component: Component,
    id: number
  ) {
    const prefix = `${team}/${environment.name}/${component.name}/${id}/`;
    const bucket = `zlifecycle-${this.ckEnvironment}-tfplan-${org.name}`;

    try {
      const objects = await this.s3h.getObjects(bucket, prefix);

      return objects.map((o) => ({
        key: o.key,
        body: o.data.Body.toString(),
      }));
    } catch (err) {
      this.logger.error(
        { message: 'error getting S3 terraform logs', prefix, bucket },
        err
      );
      throw new InternalServerErrorException('could not get logs');
    }
  }

  async getStateFile(
    org: Organization,
    team: string,
    environment: string,
    component: string
  ) {
    const prefix = `${team}/${environment}/${component}/terraform.tfstate`;
    const resp = await this.s3h.getObject(
      `zlifecycle-${this.ckEnvironment}-tfstate-${org.name}`,
      prefix
    );

    return {
      ...resp,
      data: (resp.data?.Body || '').toString() || '',
    };
  }

  async getLatestCompReconcile(
    org: Organization,
    comp: Component
  ): Promise<ComponentReconcile> {
    const whereClause = {
      component: {
        id: comp.id,
      },
      status: And(Not(Like('skipped%')), Not('waiting_for_parent')),
      organization: {
        id: org.id,
      },
    };
    return this.compReconRepo.findOne({
      where: [
        {
          ...whereClause,
          isSkipped: IsNull(),
        },
        {
          ...whereClause,
          isSkipped: false,
        },
      ],
      order: {
        startDateTime: -1,
      },
    });
  }

  async getLatestLogs(
    org: Organization,
    team: string,
    environment: Environment,
    component: Component,
    latestCompRecon: ComponentReconcile
  ) {
    return await this.getLogs(
      org,
      team,
      environment,
      component,
      latestCompRecon.reconcileId
    );
  }

  async updateCost(env: Environment) {
    let estimatedCost = 0.0;
    for (const comp of env.components) {
      if (comp.latestCompRecon?.estimatedCost > 0) {
        estimatedCost += comp.latestCompRecon.estimatedCost;
      }
    }

    const envRecon = env.latestEnvRecon;

    delete envRecon.componentReconciles;

    await this.envReconRepo.merge(envRecon, {
      estimatedCost,
    });

    await this.envReconRepo.save(envRecon);
  }
}
