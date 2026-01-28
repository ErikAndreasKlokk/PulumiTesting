# PulumiTesting

Testing out Pulumi as an alternative to Terraform

## Installation

```bash
brew install pulumi/tap/pulumi
```

```bash
pulumi version
# Example output: v3.215.0
```

Pulumi will use the same kubeconfig as kubectl by default. You can check your current context with:

```bash
kubectl config current-context
```

If you need to switch contexts, you can do so with:

```bash
pulumi config set kubernetes:context my-cluster-context
```

## Usage

1. Create and deploy the Pulumi stack:

    ```bash
    pulumi up
    # Review the changes and confirm the deployment
    ```

2. After deployment, you can access the RabbitMQ management interface by port-forwarding the service in another terminal window:

    ```bash
    kubectl --kubeconfig=/tmp/kind-kubeconfig-kind-pulumi.yaml port-forward -n rabbitmq-system svc/ldap-rabbitmq-cluster 5672:5672 15672:15672
    ```

3. Open your web browser and navigate to `http://localhost:15672/`.

4. Use the exported RabbitMQ username and password to log in.

    ```bash
    pulumi stack output --show-secrets
    ```

5. Test sending a message to the RabbitMQ server using the provided test_rabbit.py script (or any RabbitMQ client of your choice).

6. Make sure you have the `pika` library installed for Python:

    ```bash
    pip3 install -r requirements.txt
    ```

7. Run the test script:

    ```bash
    python3 test_rabbit.py -u <username> -p <password> -m "Hello" -q q.test -v Test

    python3 test_rabbit.py -u <username> -p <password> -r -q q.test -v Test
    ```

8. To destroy the deployed resources:

    ```bash
    pulumi destroy
    ```
