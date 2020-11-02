import * as cdk from '@aws-cdk/core';
import * as codebuild from '@aws-cdk/aws-codebuild';
import * as codecommit from '@aws-cdk/aws-codecommit';
import * as codepipeline from '@aws-cdk/aws-codepipeline';
import * as codepipeline_actions from '@aws-cdk/aws-codepipeline-actions';
import * as ecr from '@aws-cdk/aws-ecr';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as iam from '@aws-cdk/aws-iam';
import * as loadbalancing from '@aws-cdk/aws-elasticloadbalancingv2';
import * as logs from "@aws-cdk/aws-logs";
import * as pipelines from '@aws-cdk/pipelines';
import { Certificate, CertificateValidation } from '@aws-cdk/aws-certificatemanager';
import { ARecord, HostedZone, RecordTarget } from '@aws-cdk/aws-route53';
import { LoadBalancerTarget } from '@aws-cdk/aws-route53-targets';
import { ApplicationLoadBalancer, ApplicationProtocol, ListenerCondition } from '@aws-cdk/aws-elasticloadbalancingv2';
import { IEcsLoadBalancerTarget } from '@aws-cdk/aws-ecs';

export type EnvVars = Record<string, string>;

export type ShoeStringEnvironment = {
  name: string;
  appPort: number;
  envVariables?: EnvVars,
  withTaskRole?: (role: iam.IRole) => void;
  withLogGroup?: (logGroup: logs.ILogGroup) => void;
  lbPort?: number;
  dnsRecordName?: string; // only the www part of www.example.com
  containerDefnProps?: ecs.ContainerDefinitionProps;
  postDeployManualApproval?: boolean;
}

export interface CdkShoestringDockerEcsAppProps {
  codeRepositoryName: string;
  ecrRepositoryName: string;
  ecrLifecycleRules?: ecr.LifecycleRule[];
  clusterInstanceType?: ec2.InstanceType;
  pipelineName?: string;
  synthSubdirectory?: string;
  buildCommand?: string;
  environments: ShoeStringEnvironment[];
  healthCheck?: loadbalancing.HealthCheck;
  region: string;
  setupServices?: boolean;
  setupListeners?: boolean;
  hostedZoneId?: string;
  domainName?: string;
}

interface AppEnvAndDeployStageProps {
  envName: string;
  certificate?: Certificate;
  cluster: ecs.ICluster;
  ecrRepo: ecr.Repository;
  imageName: string;
  port: number;
  loadBalancer: loadbalancing.ApplicationLoadBalancer;
  input: codepipeline.Artifact;
  pipeline: pipelines.CdkPipeline;
  lbPort?: number;
  environment?: Record<string, string>;
  withTaskRole?: (role: iam.IRole) => void;
  withLogGroup?: (logGroup: logs.ILogGroup) => void;
  healthCheck?: loadbalancing.HealthCheck;
  region: string;
  dnsRecordName?: string; // only the www part of www.example.com
  domainName?: string;
  setupListeners?: boolean;
  containerDefnProps?: ecs.ContainerDefinitionProps;
  postDeployManualApproval?: boolean;
}

interface AppEnv {
  service: ecs.IBaseService;
  targetConfig?: TargetConfig;
}

interface AppEnvProps {
  envName: string;
  certificate?: Certificate;
  cluster: ecs.ICluster;
  ecrRepo: ecr.Repository;
  imageName: string;
  loadBalancer: loadbalancing.ApplicationLoadBalancer;
  port: number;
  lbPort?: number;
  environment?: Record<string, string>;
  withTaskRole?: (role: iam.IRole) => void;
  withLogGroup?: (logGroup: logs.ILogGroup) => void;
  healthCheck?: loadbalancing.HealthCheck;
  region: string;
  dnsRecordName?: string; // only the www part of www.example.com
  domainName?: string;
  setupListeners?: boolean;
  containerDefnProps?: ecs.ContainerDefinitionProps;
}

interface AppStageProps {
  appEnv: AppEnv;
  input: codepipeline.Artifact;
  pipeline: pipelines.CdkPipeline;
  stageName: string;
  postDeployManualApproval?: boolean;
}

interface AppBuildProps {
  pipeline: pipelines.CdkPipeline;
  input: codepipeline.Artifact;
  ecrRepo: ecr.Repository;
  appBuildArtifact: codepipeline.Artifact;
  imageName: string;
  region: string;
}

interface TargetConfig {
  target: IEcsLoadBalancerTarget,
  hostnames: string[]
  port: number;
}

const LATEST_IMAGE_NAME = "latest";

export class CdkShoestringDockerEcsApp extends cdk.Construct {
  constructor(scope: cdk.Construct, id: string, props: CdkShoestringDockerEcsAppProps) {
    super(scope, id);

    const repository = new codecommit.Repository(this, "Repository", {
      repositoryName: props.codeRepositoryName,
    });

    const ecrRepo = new ecr.Repository(this, "EcrRepo", {
      repositoryName: props.ecrRepositoryName,
      lifecycleRules: props.ecrLifecycleRules || [{ maxImageCount: 100 }],
    });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0, // these are expensive. ditch them.
    })

    // share a cluster and load balancer between envs to save $
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      capacity: {
        instanceType: props.clusterInstanceType || new ec2.InstanceType("t3a.nano"),
        /** 
         * needed to avoid nats
         * https://docs.aws.amazon.com/vpc/latest/userguide/vpce-interface.html
         * */
        associatePublicIpAddress: true,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
        }
      },
    });

    const loadBalancer = new loadbalancing.ApplicationLoadBalancer(this, "LB", {
      vpc,
      internetFacing: true,
    });

    const { certificate, zone } = this.setupDomain(loadBalancer, props);

    // The code that defines your stack goes here
    const sourceArtifact = new codepipeline.Artifact();
    const cloudAssemblyArtifact = new codepipeline.Artifact();
    const appBuildArtifact = new codepipeline.Artifact();

    const pipeline = new pipelines.CdkPipeline(this, "Pipeline", {
      // The pipeline name
      pipelineName: props.pipelineName,
      cloudAssemblyArtifact,

      sourceAction: new codepipeline_actions.CodeCommitSourceAction({
        actionName: "CodeCommit",
        output: sourceArtifact,
        repository,
      }),

      // How it will be built and synthesized
      synthAction: pipelines.SimpleSynthAction.standardNpmSynth({
        subdirectory: props.synthSubdirectory,
        sourceArtifact,
        cloudAssemblyArtifact,

        buildCommand: props.buildCommand,
      }),
    });

    const imageName = props.ecrRepositoryName;

    this.createAppBuild({
      appBuildArtifact,
      input: sourceArtifact,
      pipeline,
      ecrRepo,
      imageName,
      region: props.region,
    });

    const baseEnvAndDeployProps = {
      ...props,
      certificate,
      zone,
      cluster,
      ecrRepo,
      imageName,
      loadBalancer,
      input: appBuildArtifact,
      pipeline,
    };

    if (props.setupServices) {
      // this purpose here is so we can get a single app build in to populate
      // the repo, then do another deploy after with setupServices:true
      // to create the services and containers so the deploy is successful.
      const appEnvs = props.environments.map(environment => {
        const { envVariables, appPort, name, ...restEnv } = environment;
        return this.createAppEnvAndDeployStage({
          ...baseEnvAndDeployProps,
          ...restEnv,
          envName: name,
          port: appPort,
          environment: envVariables,
        });
      });

      const targetConfigs: TargetConfig[] = (appEnvs.filter(env => env.targetConfig).map(env => env.targetConfig) as TargetConfig[]);

      if (props.setupListeners && targetConfigs && targetConfigs.length > 0) {

        if (certificate) {
          this.setupProtocolListener(loadBalancer, ApplicationProtocol.HTTPS, targetConfigs, props, certificate);

          loadBalancer.addRedirect({
            sourcePort: 80,
            sourceProtocol: ApplicationProtocol.HTTP,
            targetPort: 443,
            targetProtocol: ApplicationProtocol.HTTPS
          });
        } else {
          // setup port 80 listener
          this.setupProtocolListener(loadBalancer, ApplicationProtocol.HTTP, targetConfigs, props);
        }
      }
    }
  }

  setupProtocolListener(loadBalancer: ApplicationLoadBalancer, protocol: ApplicationProtocol, targetConfigs: TargetConfig[], props: CdkShoestringDockerEcsAppProps, certificate?: Certificate) {
    const listener = loadBalancer.addListener(`${protocol}-Listener`, { protocol, certificates: certificate ? [certificate] : undefined });

    targetConfigs.forEach((config, i) => {
      const hostnames = config?.hostnames;
      const conditions = i < targetConfigs.length - 1
        ? [ListenerCondition.hostHeaders(hostnames)]
        : undefined;
      if (hostnames && config) {
        listener.addTargets(`Target-${i}`, {
          priority: conditions ? i + 1 : undefined,
          conditions,
          targets: [config.target],
          protocol: loadbalancing.ApplicationProtocol.HTTP,
          healthCheck: props.healthCheck,
        });
      } else {
        throw new Error('missing hostnames or target config undefined');
      }
    });
  }

  setupDomain(loadBalancer: ApplicationLoadBalancer, props: CdkShoestringDockerEcsAppProps) {
    if (props.domainName && props.hostedZoneId) {
      const zone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.domainName,
      });

      const recordNames = props.environments.map(env => env.dnsRecordName);
      const subjectAlternativeNames = props.environments.map(env => `${env.dnsRecordName}.${props.domainName}`);

      const certificate = new Certificate(this, 'Certificate', {
        domainName: props.domainName,
        validation: CertificateValidation.fromDns(zone),
        subjectAlternativeNames,
      });

      // we have dns, so setup an A Record
      const lbTarget = RecordTarget.fromAlias(new LoadBalancerTarget(loadBalancer));

      // undefined handles the root dns
      recordNames.concat([undefined]).forEach(recordName => {
        new ARecord(this, `ARecord-${recordName || 'Root'}`, {
          zone,
          recordName,
          target: lbTarget,
        });
      })


      return { zone, certificate };
    }

    return {};
  }

  createAppEnvAndDeployStage(props: AppEnvAndDeployStageProps): AppEnv {
    const appEnv = this.createAppEnvironment(props);

    this.createDeployStage({
      ...props,
      appEnv: appEnv,
      stageName: props.envName,
    });

    return appEnv;
  }

  createAppEnvironment(props: AppEnvProps): AppEnv {
    const {
      cluster,
      ecrRepo,
      envName,
      imageName,
      loadBalancer,
      port,
      lbPort,
      environment,
      withTaskRole,
      withLogGroup,
      healthCheck,
      dnsRecordName,
      domainName,
      setupListeners,
      containerDefnProps,
    } = props;

    const taskDefinition = new ecs.Ec2TaskDefinition(this, `AppTask${envName}`);

    if (withTaskRole) {
      withTaskRole(taskDefinition.taskRole);
    }

    const logging = new ecs.AwsLogDriver({
      streamPrefix: `${imageName}-${envName}`,
    });

    const container = taskDefinition.addContainer(imageName, {
      // serve the docker getting started image. later builds will overwrite this.
      ...containerDefnProps,
      image: ecs.EcrImage.fromEcrRepository(ecrRepo, 'latest'),
      memoryReservationMiB: 100,
      logging,
      environment,
    });

    container.addPortMappings({
      containerPort: port,
      protocol: ecs.Protocol.TCP,
    });

    const service = new ecs.Ec2Service(this, "AppService" + envName, {
      cluster,
      taskDefinition,
    });

    const target: IEcsLoadBalancerTarget = service.loadBalancerTarget({
      containerName: imageName,
      containerPort: port,
      protocol: ecs.Protocol.TCP,
    });

    // calling this late to ensure that the log group has been setup
    // since the log group only gets created when bind is called
    // which happens after the log driver is added to a container
    if (withLogGroup && logging.logGroup) {
      withLogGroup(logging.logGroup);
    }

    let targetConfig: TargetConfig | undefined = undefined;

    if (setupListeners) {
      if (domainName) {
        if (!dnsRecordName) {
          throw new Error('dnsRecordName missing for ' + envName);
        } 

        targetConfig = {
          target: target,
          hostnames: [`${dnsRecordName}.${domainName}`],
          port,
        };
      } else {
        // no domain name, so setup port listeners
        const listener = loadBalancer.addListener("Listener" + envName, {
          port: lbPort || port,
          protocol: ApplicationProtocol.HTTP,
        });

        listener.addTargets("Target" + envName, {
          port,
          targets: [target],
          protocol: loadbalancing.ApplicationProtocol.HTTP,
          healthCheck,
        });
      }
    }

    return { service, targetConfig };
  }

  createDeployStage({ appEnv, input, pipeline, stageName, postDeployManualApproval }: AppStageProps) {
    const betaStage = pipeline.addStage(stageName);

    betaStage.addActions(
      new codepipeline_actions.EcsDeployAction({
        actionName: `${stageName}EcsDeploy`,
        service: appEnv.service,
        runOrder: betaStage.nextSequentialRunOrder(),
        input,
      })
    );

    if (postDeployManualApproval) {
      betaStage.addManualApprovalAction({
        runOrder: betaStage.nextSequentialRunOrder(),
      });
    }
  }

  createAppBuild({
    appBuildArtifact,
    input,
    pipeline,
    ecrRepo,
    imageName,
    region,
  }: AppBuildProps) {
    const project = new codebuild.PipelineProject(this, "AppBuildProject", {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_4_0,
        privileged: true,
        environmentVariables: {
          IMAGE_NAME: { value: imageName },
          REPO_URI: { value: ecrRepo.repositoryUri },
          AWS_REGION: { value: region },
          IMAGE_TAG: { value: LATEST_IMAGE_NAME },
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              "echo $REPO_URI",
              "export BUILD_ID=build-`date +%s`",
              "echo Build is $BUILD_ID",
              "echo Logging in to Amazon ECR...",
              "aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REPO_URI",
            ],
          },
          build: {
            commands: [
              "echo Build started on `date`",
              "echo Building the Docker image...",
              "docker build -t $IMAGE_NAME:$IMAGE_TAG .",
              "docker tag $IMAGE_NAME:$IMAGE_TAG $REPO_URI:$IMAGE_TAG",
              "docker tag $IMAGE_NAME:$IMAGE_TAG $REPO_URI:$BUILD_ID",
            ],
          },
          post_build: {
            commands: [
              "echo Build completed on `date`",
              "echo Pushing the Docker image...",
              "docker push $REPO_URI:$IMAGE_TAG",
              "docker push $REPO_URI:$BUILD_ID",
              `printf '[{"name": "%s", "imageUri": "%s"}]' $IMAGE_NAME $REPO_URI:$BUILD_ID > imagedefinitions.json`,
            ],
          },
        },
        artifacts: {
          files: ["imagedefinitions.json"],
        },
      }),
    });

    project.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonEC2ContainerRegistryReadOnly"
      )
    );
    if (project.role) {
      ecrRepo.grantPullPush(project.role);
    }

    const appBuildStage = pipeline.addStage("AppBuild");
    appBuildStage.addActions(
      new codepipeline_actions.CodeBuildAction({
        actionName: "AppBuild",
        input,
        outputs: [appBuildArtifact],
        project,
      })
    );
  }
}

