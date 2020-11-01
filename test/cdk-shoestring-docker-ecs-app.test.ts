import { expect as expectCDK, countResources, haveResource, arrayWith, objectLike, anything, ABSENT } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import * as shoestring from '../lib/index';

const context = {
  '@aws-cdk/core:newStyleStackSynthesis': true
};

/*
 * Example test 
 */
test('ECS Service not created', () => {
  const app = new cdk.App({ context });
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
  expectCDK(stack).to(countResources("AWS::ECS::Service",0));
});


test('ECS Service created', () => {
  const app = new cdk.App({ context });
  const stack = new cdk.Stack(app, "TestStack");
  // WHEN
  new shoestring.CdkShoestringDockerEcsApp(stack, 'MyShoestringStartupApp', {
    codeRepositoryName: 'commitRepo',
    ecrRepositoryName: 'ecrRepo',
    region: 'us-east-1',
    setupServices: true,
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

// useful before dns is setup
test('Use port-based routing', () => {
  const app = new cdk.App({ context });
  const stack = new cdk.Stack(app, "TestStack");
  // WHEN
  new shoestring.CdkShoestringDockerEcsApp(stack, 'MyShoestringStartupApp', {
    codeRepositoryName: 'commitRepo',
    ecrRepositoryName: 'ecrRepo',
    region: 'us-east-1',
    setupServices: true,
    setupListeners: true,
    environments: [
      {
        appPort: 4000,
        envVariables: {
          PORT: '4000',
        },
        name: 'Beta',
        dnsRecordName: 'beta',
      },
      {
        appPort: 5000,
        envVariables: {
          PORT: '5000',
        },
        name: 'Gamma',
        dnsRecordName: 'gamma',
      },
      {
        appPort: 4000,
        lbPort: 80,
        envVariables: {
          PORT: '4000',
        },
        name: 'Prod',
        dnsRecordName: 'prod',
      }
    ]
  });
  // THEN
  expectCDK(stack).to(countResources("AWS::ElasticLoadBalancingV2::Listener",3));
  expectCDK(stack).to(haveResource('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 4000,
    Protocol: "HTTP",
    DefaultActions: [objectLike({Type: "forward"})]
  }));
  expectCDK(stack).to(haveResource('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 5000,
    Protocol: "HTTP",
    DefaultActions: [objectLike({Type: "forward"})]
  }));
  expectCDK(stack).to(haveResource('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 80,
    Protocol: "HTTP",
    DefaultActions: [objectLike({Type: "forward"})]
  }));
  expectCDK(stack).to(countResources("AWS::Route53::RecordSet",0));
});


test('Use host-based routing', () => {
  const app = new cdk.App({ context });
  const stack = new cdk.Stack(app, "TestStack");
  // WHEN
  new shoestring.CdkShoestringDockerEcsApp(stack, 'MyShoestringStartupApp', {
    domainName: 'foo.bar.com',
    hostedZoneId: 'abc123',
    codeRepositoryName: 'commitRepo',
    ecrRepositoryName: 'ecrRepo',
    region: 'us-east-1',
    setupServices: true,
    setupListeners: true,
    environments: [
      {
        appPort: 4000,
        envVariables: {
          PORT: '4000',
        },
        name: 'Beta',
        dnsRecordName: 'beta',
      },
      {
        appPort: 4000,
        envVariables: {
          PORT: '4000',
        },
        name: 'Gamma',
        dnsRecordName: 'gamma',
      },
      {
        appPort: 4000,
        envVariables: {
          PORT: '4000',
        },
        name: 'Prod',
        dnsRecordName: 'prod',
      }
    ]
  });
  // THEN
  expectCDK(stack).to(countResources("AWS::ElasticLoadBalancingV2::Listener",2));
  expectCDK(stack).to(haveResource('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 80,
    Protocol: "HTTP",
    DefaultActions: [objectLike({Type: "redirect"})]
  }));
  expectCDK(stack).to(haveResource('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 443,
    Protocol: "HTTPS",
    Certificates: arrayWith(objectLike({CertificateArn: anything()})),
    DefaultActions: [objectLike({Type: "forward"})]
  }));
  expectCDK(stack).to(haveResource('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Priority: 1,
    Conditions: [objectLike({HostHeaderConfig: {Values: ['beta.foo.bar.com']}})]
  }));
  expectCDK(stack).to(haveResource('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Priority: 2,
    Conditions: [objectLike({HostHeaderConfig: {Values: ['gamma.foo.bar.com']}})]
  }));

  // one for each domain and one for the root domain
  expectCDK(stack).to(countResources("AWS::Route53::RecordSet",4));
  expectCDK(stack).to(haveResource('AWS::Route53::RecordSet', { Name: 'beta.foo.bar.com.' }));
  expectCDK(stack).to(haveResource('AWS::Route53::RecordSet', { Name: 'gamma.foo.bar.com.' }));
  expectCDK(stack).to(haveResource('AWS::Route53::RecordSet', { Name: 'prod.foo.bar.com.' }));
  expectCDK(stack).to(haveResource('AWS::Route53::RecordSet', { Name: 'foo.bar.com.' }));
});
