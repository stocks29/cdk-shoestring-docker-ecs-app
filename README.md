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
    ]
  });
```
