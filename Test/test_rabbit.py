"""
RabbitMQ Connection and Messaging Utility
Allows checking connection to a RabbitMQ server, sending and consuming messages.
"""
import argparse
import ssl
import sys
import time
from typing import Dict, Any

import pika


def parse_arguments() -> Dict[str, Any]:
    """Parse and return command line arguments."""
    parser = argparse.ArgumentParser(
        description='Check connection to RabbitMQ server and optionally send or consume messages'
    )
    parser.add_argument('--server', default='localhost',
                        help='Define RabbitMQ server (default: %(default)s)')
    parser.add_argument('--sslserver',
                        help='Define RabbitMQ SSL server')
    parser.add_argument('-v', '--virtual_host', '--vhost', default='/',
                        help='Define virtual host (default: %(default)s)')
    parser.add_argument('--ssl', action='store_true',
                        help='Enable SSL (default: %(default)s)')
    parser.add_argument('--port', type=int, default=5672,
                        help='Define port (default: %(default)s)')
    parser.add_argument('-u', '--username', '--pass', default='user',
                        help='Define username (default: %(default)s)')
    parser.add_argument('-p', '--password', '--user', default='user1234',
                        help='Define password (default: %(default)s)')
    parser.add_argument('--sleep', nargs='?', const=10, type=int,
                        help='Sleep to keep connection open (default: %(default)s seconds)')
    parser.add_argument('-q', '--queue',
                        help='Queue name to send message to')
    parser.add_argument('-m', '--message', '--send', action='append',
                        help='Message(s) to send to the queue. Repeat flag to send multiple messages')
    parser.add_argument('-r', '--receive', '--consume', action='store_true', default=False,
                        help='Receive messages from queue')
    parser.add_argument('-c', '--count', default=1, type=int,
                        help='Number of messages to send or receive (default: 1, use 0 for unlimited)')
    parser.add_argument('-e', '--exchange', default='',
                        help='Exchange to use when sending messages (default: %(default)s)')

    args = parser.parse_args()
    return vars(args)


def setup_connection_parameters(config: Dict[str, Any]) -> pika.ConnectionParameters:
    """Set up and return RabbitMQ connection parameters."""
    credentials = pika.PlainCredentials(config['username'], config['password'])

    ssl_options = None
    if config['ssl']:
        context = ssl.create_default_context()
        ssl_options = pika.SSLOptions(context, config['sslserver'])

    return pika.ConnectionParameters(
        host=config['server'],
        port=config['port'],
        virtual_host=config['virtual_host'],
        credentials=credentials,
        ssl_options=ssl_options
    )


def send_messages(channel: pika.channel.Channel, queue: str, messages: list[str], sleep: int = None,
                  count: int = 1, exchange: str = '') -> None:
    """Send messages to the specified queue."""
    send_info = f'📮 Sending messages to queue "{queue}" until interrupted' \
        if count == 0 else f'📮 Sending {count * len(messages)} message{"s" if count != 1 else ""} to queue "{queue}"'

    send_info += f', sleeping for {sleep} seconds between each...' \
        if sleep is not None and count != 1 else '...'

    print(send_info)

    sent_messages = 0
    try:
        is_infinite = count <= 0
        iterations = float('inf') if is_infinite else count * len(messages)

        while sent_messages < iterations:
            for message in messages:
                channel.basic_publish(
                    exchange=exchange, 
                    routing_key=queue,
                    body=message,
                    properties=pika.BasicProperties(
                        delivery_mode=2,  # Make message persistent
                    )
                )
                sent_messages += 1
                padding = len(str(count * len(messages))) if count != 0 else 6
                print(f'✉️ Sent message {sent_messages:{padding}d} to "{exchange}" "{queue}": {message}')
                if sleep is not None:
                    time.sleep(sleep)

    except KeyboardInterrupt:
        print(f'🛑 Stopped sending messages.')
        return
    else:
        print(f'📨 Sent {sent_messages} messages.')


def consume_messages(channel: pika.channel.Channel, queue: str, count: int = 1, sleep: int = None) -> None:
    """Consume messages from the specified queue."""
    consume_info = f'📯 Consuming messages from queue "{queue}" until interrupted' \
        if count == 0 else f'📯 Consuming {count} message{"s" if count != 1 else ""} from queue "{queue}"'

    consume_info += f', sleeping for {sleep} seconds between each consumption...' \
        if sleep is not None and count != 1 else '...'

    print(consume_info)

    def callback(ch, method, properties, body):
        callback.message_count += 1
        padding = len(str(count)) if count != 0 else 6
        print(f'📩 Received message{f" {callback.message_count:{padding}d}" if count != 1 else ""}: "{body.decode()}"')
        ch.basic_ack(delivery_tag=method.delivery_tag)

        if 0 < count <= callback.message_count:
            print(f'📫 Received {count} message{"s" if count != 1 else ""}, stopping.')
            ch.stop_consuming()

        if sleep is not None:
            time.sleep(sleep)

    callback.message_count = 0

    channel.basic_qos(prefetch_count=1)
    channel.basic_consume(queue=queue, on_message_callback=callback)

    try:
        channel.start_consuming()
    except KeyboardInterrupt:
        channel.stop_consuming()
        print('🛑 Stopped consuming messages.')


def validate_arguments(args: Dict[str, Any]) -> bool:
    if args['message'] is not None and args['receive']:
        print('⚠️ Error: Cannot both send and receive messages at the same time')
        return False
    if (args['message'] is not None or args['receive']) and (args['queue'] is None):
        print('⚠️ Error: Must specify a queue when sending or receiving messages')
        return False
    if args['count'] < 0:
        print('⚠️ Error: Count must be greater than 0')
        return False
    return True


def main() -> int:
    args = parse_arguments()

    if not validate_arguments(args):
        return 1

    connection_params = setup_connection_parameters(args)

    try:
        connection = pika.BlockingConnection(connection_params)
    except Exception as error:
        print(f'⚠️ Error: {error.__class__.__name__} - {error}')
        return 1

    try:
        print('🟢 Connection: OK')
        channel = connection.channel()

        queue = args['queue']
        if queue is not None:
            if args['message'] is not None:
                send_messages(channel, queue, args['message'], args['sleep'], args['count'], args['exchange'])
            elif args['receive']:
                consume_messages(channel, queue, args['count'], args['sleep'])
            elif args['sleep'] is not None:
                sleep_time = args['sleep']
                print(f'💤 Sleeping for {sleep_time} seconds to keep connection open')
                time.sleep(sleep_time)
    except Exception as error:
        print(f'⚠️ Error: {error.__class__.__name__} - {error}')
        connection.close()
        return 1
    finally:
        connection.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())