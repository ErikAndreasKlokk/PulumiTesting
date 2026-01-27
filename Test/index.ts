import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import * as k8s from "@pulumi/kubernetes";

// Define cluster name
const clusterName = "kind-pulumi";

// Create kind cluster configuration
const kindConfig = `kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
- role: worker
`;

// Write kind config to file
const writeConfig = new command.local.Command("write-kind-config", {
    create: `cat > /tmp/kind-config.yaml << 'EOF'
${kindConfig}EOF`,
});

// Create kind cluster
const createCluster = new command.local.Command("create-kind-cluster", {
    create: `kind create cluster --name ${clusterName} --config /tmp/kind-config.yaml --wait 5m`,
    delete: `kind delete cluster --name ${clusterName}`,
}, { dependsOn: [writeConfig] });

// Get kubeconfig
const getKubeconfig = new command.local.Command("get-kubeconfig", {
    create: `kind get kubeconfig --name ${clusterName}`,
    triggers: [createCluster.id],
}, { dependsOn: [createCluster] });

// Create Kubernetes provider using the kind cluster
const k8sProvider = new k8s.Provider("kind-provider", {
    kubeconfig: getKubeconfig.stdout,
}, { dependsOn: [createCluster] });

const certmanagerNamespace = new k8s.core.v1.Namespace("cert-manager", {
    metadata: { name: "cert-manager" },
}, { provider: k8sProvider, dependsOn: [createCluster] });

// Install cert-manager
const installCertManager = new k8s.helm.v3.Chart("cert-manager", {
    chart: "cert-manager",
    version: "v1.11.0",
    fetchOpts: {
        repo: "https://charts.jetstack.io",
    },
    values: {
        installCRDs: true,
    },
}, { provider: k8sProvider, dependsOn: [certmanagerNamespace] });

// Write kubeconfig to temp file
const writeKubeconfig = new command.local.Command("write-kubeconfig", {
    create: pulumi.interpolate`echo '${getKubeconfig.stdout}' > /tmp/kind-kubeconfig-${clusterName}.yaml`,
}, { dependsOn: [getKubeconfig] });

// Wait for cert-manager CRDs to be ready
const waitForCertManager = new command.local.Command("wait-for-cert-manager", {
    create: `for i in {1..60}; do kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml get crd certificates.cert-manager.io issuers.cert-manager.io 2>/dev/null && kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml wait --for condition=established --timeout=10s crd/certificates.cert-manager.io crd/issuers.cert-manager.io && break || sleep 5; done`,
}, { dependsOn: [installCertManager, writeKubeconfig] });

// Create rabbitmq-system namespace
const rabbitmqNamespace = new k8s.core.v1.Namespace("rabbitmq-system", {
    metadata: { name: "rabbitmq-system" },
}, { provider: k8sProvider });

// Install RabbitMQ Cluster Operator using kubectl
const installRabbitMQClusterOperator = new command.local.Command("install-rabbitmq-cluster-operator", {
    create: `kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml apply -f https://github.com/rabbitmq/cluster-operator/releases/download/v2.18.0/cluster-operator.yml`,
    delete: `kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml delete --ignore-not-found=true -f https://github.com/rabbitmq/cluster-operator/releases/download/v2.18.0/cluster-operator.yml || true`,
}, { dependsOn: [rabbitmqNamespace, waitForCertManager, writeKubeconfig] });

// Install RabbitMQ Messaging Topology Operator
const installRabbitMQTopologyOperator = new command.local.Command("install-rabbitmq-topology-operator", {
    create: `kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml apply -f https://github.com/rabbitmq/messaging-topology-operator/releases/download/v1.18.2/messaging-topology-operator-with-certmanager.yaml`,
    delete: `kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml delete --ignore-not-found=true -f https://github.com/rabbitmq/messaging-topology-operator/releases/download/v1.18.2/messaging-topology-operator-with-certmanager.yaml || true`,
}, { dependsOn: [installRabbitMQClusterOperator, waitForCertManager] });

// Create LDAP bind secret
const ldapBindSecret = new k8s.core.v1.Secret("ldap-bind-secret", {
    metadata: {
        name: "ldap-bind-secret",
        namespace: "rabbitmq-system",
    },
    stringData: {
        "ldap-bind-password": "your-password-here", // Replace with actual password or use Pulumi config
    },
}, { provider: k8sProvider, dependsOn: [rabbitmqNamespace] });

// Create SPK trust bundle ConfigMap
const spkTrustBundle = new k8s.core.v1.ConfigMap("spk-trust-bundle", {
    metadata: {
        name: "spk-trust-bundle",
        namespace: "rabbitmq-system",
    },
    data: {
        "bundle.pem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----", // Replace with actual certificate
    },
}, { provider: k8sProvider, dependsOn: [rabbitmqNamespace] });

// Create RabbitMQ Cluster with LDAP configuration
const rabbitmqCluster = new k8s.apiextensions.CustomResource("rabbitmq-cluster", {
    apiVersion: "rabbitmq.com/v1beta1",
    kind: "RabbitmqCluster",
    metadata: {
        name: "ldap-rabbitmq-cluster",
        namespace: "rabbitmq-system",
    },
    spec: {
        replicas: 1,
        rabbitmq: {
            additionalConfig: `## Logging ##
log.console = true
log.console.level = debug

## Auth ##
# https://www.rabbitmq.com/docs/ldap

auth_backends.1 = internal
auth_backends.2 = cache
auth_cache.cached_backend = ldap
auth_cache.cache_ttl = 60000

## AD LDAP
auth_ldap.servers.1 = mdc11.spk.no
auth_ldap.servers.2 = mdc12.spk.no
auth_ldap.servers.3 = mdc13.spk.no
auth_ldap.use_ssl = true
auth_ldap.ssl_options.cacertfile = /etc/rabbit/pki/spk-certificates/bundle.pem
auth_ldap.port = 636
auth_ldap.timeout = 60000
auth_ldap.idle_timeout = 300000

auth_ldap.dn_lookup_bind.user_dn = CN=Sa-RabbitMQ-Test,OU=Service Accounts,OU=Drift,DC=spk,DC=no
auth_ldap.dn_lookup_bind.password = $(LDAP_BIND_PASSWORD)

auth_ldap.dn_lookup_base = DC=spk,DC=no
auth_ldap.dn_lookup_attribute = sAMAccountName
auth_ldap.group_lookup_base = OU=Grupper,DC=spk,DC=no`,
            additionalPlugins: ["rabbitmq_auth_backend_ldap", "rabbitmq_auth_backend_cache", "rabbitmq_event_exchange"],
            advancedConfig: `[
  {rabbitmq_auth_backend_ldap, [
    {vhost_access_query, {in_group_nested, "CN=App-RabbitMQ-VHost-\${vhost}-Test,OU=RabbitMQ,OU=Applikasjon,OU=Grupper,DC=spk,DC=no"}},
    {tag_queries, [
      {administrator, {in_group_nested, "CN=App-RabbitMQ-Admin-Test,OU=RabbitMQ,OU=Applikasjon,OU=Grupper,DC=spk,DC=no"}},
      {monitoring, {in_group_nested, "CN=App-RabbitMQ-Monitoring-Test,OU=RabbitMQ,OU=Applikasjon,OU=Grupper,DC=spk,DC=no"}},
      {management, {in_group_nested, "CN=App-RabbitMQ-Management-Test,OU=RabbitMQ,OU=Applikasjon,OU=Grupper,DC=spk,DC=no"}}
    ]},
    {resource_access_query, {for, [
      {permission, configure, {in_group_nested, "CN=App-RabbitMQ-Configure-Test,OU=RabbitMQ,OU=Applikasjon,OU=Grupper,DC=spk,DC=no"}},
      {permission, write, {constant, true}},
      {permission, read, {constant, true}}
    ]}}
  ]}
].`
        },
        override: {
            statefulSet: {
                spec: {
                    template: {
                        spec: {
                            containers: [{
                                name: "rabbitmq",
                                env: [{
                                    name: "LDAP_BIND_PASSWORD",
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: "ldap-bind-secret",
                                            key: "ldap-bind-password",
                                        },
                                    },
                                }],
                                volumeMounts: [{
                                    name: "spk-certificates",
                                    mountPath: "/etc/rabbit/pki/spk-certificates",
                                }],
                            }],
                            volumes: [{
                                name: "spk-certificates",
                                configMap: {
                                    name: "spk-trust-bundle",
                                },
                            }],
                        },
                    },
                },
            },
        },
    },
}, { provider: k8sProvider, dependsOn: [installRabbitMQClusterOperator, installRabbitMQTopologyOperator, ldapBindSecret, spkTrustBundle] });

// Get the default user credentials from the secret created by the RabbitMQ operator
// Wait for RabbitMQ pods to be ready
const waitForRabbitMQ = new command.local.Command("wait-for-rabbitmq", {
    create: `for i in {1..60}; do kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml get pod -l app.kubernetes.io/name=ldap-rabbitmq-cluster -n rabbitmq-system 2>/dev/null && kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml wait --for=condition=ready pod -l app.kubernetes.io/name=ldap-rabbitmq-cluster -n rabbitmq-system --timeout=10s && break || sleep 5; done`,
}, { dependsOn: [rabbitmqCluster, writeKubeconfig] });

// Get the default user secret
const defaultUserSecret = k8s.core.v1.Secret.get("rabbitmq-default-user", 
    pulumi.interpolate`rabbitmq-system/ldap-rabbitmq-cluster-default-user`,
    { provider: k8sProvider, dependsOn: [waitForRabbitMQ] }
);

// apply test queue from test_rabbit.yaml
const applyTestQueue = new command.local.Command("apply-test-queue", {
    create: `kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml apply -f ${process.cwd()}/test_rabbit.yaml -n rabbitmq-system`,
    delete: `kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml delete --ignore-not-found=true -f ${process.cwd()}/test_rabbit.yaml -n rabbitmq-system || true`,
}, { dependsOn: [waitForRabbitMQ] });

// Export outputs
export const clusterNameOutput = clusterName;
// export const kubeconfig = getKubeconfig.stdout;
export const rabbitmqDefaultUsername = defaultUserSecret.data.apply(data => 
    Buffer.from(data["username"], "base64").toString()
);
export const rabbitmqDefaultPassword = defaultUserSecret.data.apply(data => 
    pulumi.secret(Buffer.from(data["password"], "base64").toString())
);

export const portForwardCommand = `kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml port-forward -n rabbitmq-system svc/ldap-rabbitmq-cluster 5672:5672 15672:15672`;
export const rabbitmqManagementUrl = `http://localhost:15672/`;