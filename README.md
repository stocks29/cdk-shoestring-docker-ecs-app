# cdk-shoestring-docker-ecs-app

A very opinionated cdk construct which creates a cheap stack for shoestringing apps early on. 

This library is in the very early stages and subject to breaking changes. Use at your own risk.

Creates a single ECS cluster and runs services/containers for multiple environments on the cluster. It uses EC2 clusters since they're cheaper than Fargate. It also uses a single load balancer for all environments since that is typically the most expensive piece of hardware. All environments must be in the same account/region. 

If you're looking to deploy a scrappy startup app and save $ this library might be for you. If you're looking to deploy an enterprise application to multiple accounts/regions and cost is no object, this is not for you.

```typescript

  const dataBucket = new s3.Bucket(this, `DataBucket`);

  new shoestring.CdkShoestringDockerEcsApp(stack, 'MyShoestringStartupApp', {
    /**
     * Name to give the new code commit repo that will be created
     */
    codeRepositoryName: 'MyAppCodeCommitRepo',

    /**
     * Name to give the ECR repo that will be created
     */
    ecrRepositoryName: 'MyAppEcrRepo',

    /**
     * Name to give the pipeline that will be created
     */
    pipelineName: 'MyAppPipeline',

    /**
     * Defaults to a t3a.nano in the spirit of shoestring budgets.
     * You'd be surprised what can run on one of these.
     */
    clusterInstanceType: new ec2.InstanceType("t3a.micro"),

    /**
     * Region to setup the entire stack (pipeline and all envs) in.
     */
    region: 'us-east-1',

    /**
     * Command to build your application during the CDK synth process.
     * This can be left off if you don't need it.
     */
    buildCommand: 'npm run build',

    /**
     * Subdirectory that your CDK code lives in (if not the root of your project)
     */
    synthSubdirectory: 'infrastructure',

    /**
     * Heath check params. These will be passed directly to the target
     */
    healthCheck: {
      path: "/health",
      healthyThresholdCount: 2,
    },

    /**
     * Each element in this array represents an environment to create.
     * Note that because we're on a shoestring budget, all environments
     * must live in the same account/region.
     */
    environments: [
      {
        /**
         * Name of your environment. This will be used for the stage name
         * and some logical ids.
         */
        name: 'Prod',

        /**
         * Port that the application container is running on. Most frameworks
         * default to running on port 3000, 4000, 8000, 8080, etc..
         */
        appPort: 4000,

        /**
         * The port to expose the environment on in the load balancer. If you
         * specify the same host for 2 environments, CFN will error.
         */
        lbPort: 80,

        /**
         * Environment variables to pass to the docker container. In this example
         * we're selling the application which port to run on.
         */
        envVariables: {
          PORT: '4000',
        },

        /**
         * Callback which receives the task role. Granting access to this role
         * will allow your the envs docker container (and therefore your application
         * runnning in it) to call these services.
         */
        withTaskRole: role => {
          dataBucket.grantReadWrite(role);
        },

        /**
         * If you pass domainName on the parent and specify a dnsRecordName,
         * an dns record will be added for this environment and a certificate
         * will be setup
         * 
         * If dns routing is configured then lbPorts settings are ignored.
         */
        dnsRecordName: 'prod',

        /**
         * Passed right through to the container definition
         */
        containerDefnProps: { ... },

        /**
         * If you want to add a manual approval step after a stage.
         * This is useful for pre-prod environments where you
         * don't want the current environment to update (nor pass the
         * change to prod) until someone has had a chance to review
         * and approve or reject it.
         */
        postDeployManualApproval: true
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

    /**
     * If transitioning to a hostname env routing, you can deploy with false
     * to remove the listeners and then with true to add in hostname listeners
     * if you're getting errors about duplicate listeners.
     */
    setupListeners: true,

    /**
     * Specify to use DNS routing. Must also specify hostedZoneId
     */
    domainName: 'foo.bar.com',

    /**
     * Hosted zone which controls the domain name specified above.
     * New records will be added to this hosted zone. One for each
     * environment using the dnsRecordName as the subdomain for that
     * env.
     * 
     * The last environment (by order) will be the default action
     * on the loadbalancer and catch any requests routed to the LB
     * for which no other domain conditions are matched. The idea
     * is that production is generally the last environment.
     */
    hostedZoneId: 'ABC123456789', 
  });
```

## Resources

This creates:

* CodeCommit repo which you can push to in order to trigger automated builds
* ECR Repo to house your docker image builds. By default it only keeps 100 images
* CodePipeline which automatically build your docker image and deploy it to an ECR repo. It also updates your infrastructure and pipeline automatically when your CDK code changes (using self-mutation from CDK Pipelines).
* A single ECS cluster regardless of how many environments you have. You can set instance size
* A single ALB reglardless of how many environments you have.
* An ECS service per environment
* A single ACM certificate which works for all environments (if `domainName` and `hostedZoneId` are provided)

## Host-Based vs Port-Based Routing

This module offers two routing modes. Host-Based routing uses the hostname to route requests to the proper application environment. Port-Based routing uses port number to route requests to the proper environment. The former is preferred but requires DNS to be setup. 

Since you may not have DNS (which domain to buy?) when you start your project you can use port-based routing with the load balancer's public facing url to start building/testing. Once you've purchased your domain name (ideally though aws since it'll create the hosted zone for you) you can plug in the `domainName` and `hostedZoneId` params and we'll automatically switch to host-based routing.

When using host-based routing, a certificate will automatically be setup and all http traffic will be automatically redirected to https.