# cdk-shoestring-docker-ecs-app

A very opinionated cdk construct which creates a cheap stack for shoestringing apps early on. 

This library is in the very early stages and subject to breaking changes. Use at your own risk.

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
