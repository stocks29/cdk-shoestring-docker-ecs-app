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
import * as pipelines from '@aws-cdk/pipelines';

export type EnvVars = Record<string, string>;

export type ShoeStringEnvironment = {
  name: string;
  appPort: number;
  envVariables?: EnvVars,
  withTaskRole?: (role: iam.IRole) => void;
  lbPort?: number;
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
}

interface AppEnvAndDeployStageProps {
  envName: string;
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
  healthCheck?: loadbalancing.HealthCheck;
  region: string;
}

interface AppEnv {
  service: ecs.IBaseService;
}

interface AppEnvProps {
  envName: string;
  cluster: ecs.ICluster;
  ecrRepo: ecr.Repository;
  imageName: string;
  loadBalancer: loadbalancing.ApplicationLoadBalancer;
  port: number;
  lbPort?: number;
  environment?: Record<string, string>;
  withTaskRole?: (role: iam.IRole) => void;
  healthCheck?: loadbalancing.HealthCheck;
  region: string;
}

interface AppStageProps {
  appEnv: AppEnv;
  input: codepipeline.Artifact;
  pipeline: pipelines.CdkPipeline;
  stageName: string;
}

interface AppBuildProps {
  pipeline: pipelines.CdkPipeline;
  input: codepipeline.Artifact;
  ecrRepo: ecr.Repository;
  appBuildArtifact: codepipeline.Artifact;
  imageName: string;
  region: string;
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

    // share a cluster and load balancer between envs to save $
    const cluster = new ecs.Cluster(this, "Cluster", {
      capacity: {
        instanceType: props.clusterInstanceType || new ec2.InstanceType("t3a.nano"),
      },
    });

    const loadBalancer = new loadbalancing.ApplicationLoadBalancer(
      this,
      "LoadBalancer",
      {
        vpc: cluster.vpc,
        internetFacing: true,
      }
    );

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
      cluster,
      ecrRepo,
      imageName,
      loadBalancer,
      input: appBuildArtifact,
      pipeline,
      region: props.region,
    };

    props.environments.forEach(environment => {
      this.createAppEnvAndDeployStage({
        ...baseEnvAndDeployProps,
        envName: environment.name,
        port: environment.appPort,
        environment: environment.envVariables,
        lbPort: environment.lbPort,
      });

    });
  }

  createAppEnvAndDeployStage(props: AppEnvAndDeployStageProps) {
    const betaAppEnv = this.createAppEnvironment(props);

    this.createDeployStage({
      ...props,
      appEnv: betaAppEnv,
      stageName: props.envName,
    });
  }

  createAppEnvironment({
    cluster,
    ecrRepo,
    envName,
    imageName,
    loadBalancer,
    port,
    lbPort,
    environment,
    withTaskRole,
    healthCheck,
  }: AppEnvProps): AppEnv {
    const taskDefinition = new ecs.Ec2TaskDefinition(this, `AppTask${envName}`);

    if (withTaskRole) {
      withTaskRole(taskDefinition.taskRole);
    }

    if (taskDefinition.executionRole) {
      ecrRepo.grantPull(taskDefinition.executionRole); 
    }

    const container = taskDefinition.addContainer(imageName, {
      // serve the docker getting started image. later builds will overwrite this.
      image: ecs.EcrImage.fromRegistry('docker/getting-started'),
      memoryReservationMiB: 100,
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${imageName}-${envName}`,
      }),
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

    const listener = loadBalancer.addListener("Listener" + envName, {
      port: lbPort ? lbPort : port,
      protocol: loadbalancing.ApplicationProtocol.HTTP,
    });

    listener.addTargets("Target" + envName, {
      port,
      targets: [
        service.loadBalancerTarget({
          containerName: imageName,
          containerPort: port,
          protocol: ecs.Protocol.TCP,
        }),
      ],
      protocol: loadbalancing.ApplicationProtocol.HTTP,
      healthCheck,
    });

    return { service };
  }

  createDeployStage({ appEnv, input, pipeline, stageName }: AppStageProps) {
    const betaStage = pipeline.addStage(stageName);
    betaStage.addActions(
      new codepipeline_actions.EcsDeployAction({
        actionName: `${stageName}EcsDeploy`,
        service: appEnv.service,
        input,
      })
    );
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

