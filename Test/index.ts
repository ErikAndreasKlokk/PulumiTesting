import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import * as k8s from "@pulumi/kubernetes";
import { get } from "http";

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

// Create RabbitMQ Cluster with LDAP configuration
const rabbitmqCluster = new k8s.apiextensions.CustomResource("rabbitmq-cluster", {
    apiVersion: "rabbitmq.com/v1beta1",
    kind: "RabbitmqCluster",
    metadata: {
        name: "ldap-rabbitmq-cluster",
        namespace: "rabbitmq-system",
    },
}, { provider: k8sProvider, dependsOn: [installRabbitMQClusterOperator, installRabbitMQTopologyOperator] });

// Wait for RabbitMQ pods to be ready
const waitForRabbitMQ = new command.local.Command("wait-for-rabbitmq", {
    create: `for i in {1..60}; do kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml get pod -l app.kubernetes.io/name=ldap-rabbitmq-cluster -n rabbitmq-system 2>/dev/null && kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml wait --for=condition=ready pod -l app.kubernetes.io/name=ldap-rabbitmq-cluster -n rabbitmq-system --timeout=10s && break || sleep 5; done`,
}, { dependsOn: [rabbitmqCluster, writeKubeconfig] });

// apply test queue from test_rabbit.yaml
const applyTestQueue = new command.local.Command("apply-test-queue", {
    create: `kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml apply -f ${process.cwd()}/test_rabbit.yaml -n rabbitmq-system`,
    delete: `kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml delete --ignore-not-found=true -f ${process.cwd()}/test_rabbit.yaml -n rabbitmq-system || true`,
}, { dependsOn: [waitForRabbitMQ] });

// Get the default user secret
const defaultUserSecret = k8s.core.v1.Secret.get("rabbitmq-default-user", 
    pulumi.interpolate`rabbitmq-system/ldap-rabbitmq-cluster-default-user`,
    { provider: k8sProvider, dependsOn: [waitForRabbitMQ] }
);

// Export outputs
export const clusterNameOutput = clusterName;
// export const kubeconfig = getKubeconfig.stdout;
export const portForwardCommand = `kubectl --kubeconfig=/tmp/kind-kubeconfig-${clusterName}.yaml port-forward -n rabbitmq-system svc/ldap-rabbitmq-cluster 5672:5672 15672:15672`;
export const rabbitmqManagementUrl = `http://localhost:15672/`;
export const rabbitmqDefaultUsername = defaultUserSecret.data.apply(data => 
    Buffer.from(data["username"], "base64").toString()
);
export const rabbitmqDefaultPassword = defaultUserSecret.data.apply(data => 
    pulumi.secret(Buffer.from(data["password"], "base64").toString())
);