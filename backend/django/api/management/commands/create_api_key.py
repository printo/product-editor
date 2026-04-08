from django.core.management.base import BaseCommand
from api.models import APIKey


class Command(BaseCommand):
    help = 'Create a new API key for external integrations'

    def add_arguments(self, parser):
        parser.add_argument('name', type=str, help='Name of the API consumer (e.g., "Mobile App")')
        parser.add_argument(
            '--description',
            type=str,
            default='',
            help='Description of the API key usage'
        )
        parser.add_argument(
            '--max-requests',
            type=int,
            default=1000,
            help='Maximum requests per day (default: 1000)'
        )
        parser.add_argument(
            '--no-layouts',
            action='store_true',
            help='Disable layout generation permission'
        )
        parser.add_argument(
            '--no-list',
            action='store_true',
            help='Disable layout listing permission'
        )
        parser.add_argument(
            '--no-exports',
            action='store_true',
            help='Disable export access permission'
        )

    def handle(self, *args, **options):
        name = options['name']
        description = options['description']
        max_requests = options['max_requests']
        
        # Check if name already exists
        if APIKey.objects.filter(name=name).exists():
            self.stdout.write(
                self.style.ERROR(f'Error: API key named "{name}" already exists')
            )
            return
        
        try:
            api_key = APIKey.objects.create(
                name=name,
                key=APIKey.generate_key(name),
                description=description,
                is_active=True,
                can_generate_layouts=not options['no_layouts'],
                can_list_layouts=not options['no_list'],
                can_access_exports=not options['no_exports'],
                max_requests_per_day=max_requests,
            )
            
            self.stdout.write(
                self.style.SUCCESS(f'✓ API key created successfully for "{name}"')
            )
            self.stdout.write('')
            self.stdout.write('API Key Details:')
            self.stdout.write('-' * 50)
            self.stdout.write(f'Name: {api_key.name}')
            self.stdout.write(f'Key: {api_key.key}')
            self.stdout.write(f'Max Requests/Day: {api_key.max_requests_per_day}')
            self.stdout.write(f'Can Generate Layouts: {api_key.can_generate_layouts}')
            self.stdout.write(f'Can List Layouts: {api_key.can_list_layouts}')
            self.stdout.write(f'Can Access Exports: {api_key.can_access_exports}')
            self.stdout.write('-' * 50)
            self.stdout.write('')
            self.stdout.write('Usage:')
            self.stdout.write('Add the following header to your API requests:')
            self.stdout.write(f'Authorization: Bearer {api_key.key}')
            self.stdout.write('')
            
        except Exception as e:
            self.stdout.write(
                self.style.ERROR(f'Error: Failed to create API key: {str(e)}')
            )
