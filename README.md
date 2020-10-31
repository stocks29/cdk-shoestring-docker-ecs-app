# cdk-shoestring-docker-ecs-app

A very opinionated cdk construct which creates a cheap stack for shoestringing apps early on. 

This library is in the very early stages and subject to breaking changes. Use at your own risk.

Creates a single ECS cluster and runs services/containers for multiple environments on the cluster. It uses EC2 clusters since they're cheaper than Fargate. It also uses a single load balancer for all environments since that is typically the most expensive piece of hardware. All environments must be in the same account/region. 

If you're looking to deploy a scrappy startup app and save $ this library might be for you. If you're looking to deploy an enterprise application to multiple accounts/regions and cost is no object, this is not for you.

```typescript

  const dataBucket = new s3.Bucket(this, `DataBucket`);

  new shoestring.CdkShoestringDockerEcsApp(stack, 'MyShoestringStartupApp', {
    codeRepositoryName: 'MyAppCodeCommitRepo',
    ecrRepositoryName: 'MyAppEcrRepo',
    pipelineName: 'MyAppPipeline',
    clusterInstanceType: new ec2.InstanceType("t3a.nano"),
    region: 'us-east-1',
    buildCommand: 'npm run build',
    synthSubdirectory: 'infrastructure',
    healthCheck: {
      path: "/health",
      healthyThresholdCount: 2,
    },
    environments: [
      {
        name: 'Prod',
        appPort: 4000,
        lbPort: 80,
        envVariables: {
          PORT: '4000',
        },
        withTaskRole: role => {
          dataBucket.grantReadWrite(role);
        }
      }
    ],

    /**
     * The flag controls if the ECS Services and Tasks get created.
     * 
     * On the initial deploy, leave this off or set to false. After the
     * initial deploy, once you have at least one image deployed to your
     * ECR repo, set this to true to deploy the services/tasks.
     */
    setupServices: true,
  });
```

## Resources

This creates:

* CodeCommit repo which you can push to in order to trigger automated builds
* ECR Repo to house your docker image builds. By default it only keeps 100 images
* CodePipeline which automatically build your docker image and deploy it to an ECR repo
* A single ECS cluster regardless of how many environments you have. You can set instance size
* A single ALB reglardless of how many environments you have.
* An ECS service per environment
