import { expect as expectCDK, countResources } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import * as shoestring from '../lib/index';

/*
 * Example test 
 */
test('ECS Service Created', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  // WHEN
  new shoestring.CdkShoestringDockerEcsApp(stack, 'MyShoestringStartupApp', {
    codeRepositoryName: 'commitRepo',
    ecrRepositoryName: 'ecrRepo',
    region: 'us-east-1',
    environments: [
      {
        appPort: 4000,
        envVariables: {
          PORT: '4000',
        },
        name: 'Prod',
      }
    ]
  });
  // THEN
  expectCDK(stack).to(countResources("AWS::ECS::Service",1));
});
