/**
 * AI Service Failure Handler Component
 * Provides user-friendly error handling and manual override options for AI service failures
 */
import React, { useState, useEffect } from 'react';
import { Alert, Button, Card, Modal, Progress, Spin, Typography, List, Divider } from 'antd';
import { ExclamationCircleOutlined, ToolOutlined, ReloadOutlined, ClockCircleOutlined } from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

interface AIFailureHandlerProps {
  error: AIServiceError | null;
  onRetry?: () => void;
  onManualOverride?: (option: ManualOverrideOption) => void;
  onDismiss?: () => void;
  showBackgroundJobStatus?: boolean;
  backgroundJobId?: string;
}

interface AIServiceError {
  service: string;
  message: string;
  fallbackUsed: boolean;
  manualOverrideAvailable: boolean;
  suggestedActions: string[];
  manualOverrideOptions?: ManualOverrideOptions;
  backgroundJobId?: string;
}

interface ManualOverrideOptions {
  available: boolean;
  options: ManualOverrideOption[];
  tutorials: Tutorial[];
}

interface ManualOverrideOption {
  name: string;
  display_name: string;
  description: string;
  tools_required: string[];
  instructions?: string[];
  options?: any[];
}

interface Tutorial {
  title: string;
  url: string;
  duration: string;
}

interface BackgroundJobStatus {
  status: string;
  progress: number;
  estimated_completion: string | null;
  created_at: string;
  error_message?: string;
}

const AIFailureHandler: React.FC<AIFailureHandlerProps> = ({
  error,
  onRetry,
  onManualOverride,
  onDismiss,
  showBackgroundJobStatus = false,
  backgroundJobId
}) => {
  const [showManualOptions, setShowManualOptions] = useState(false);
  const [backgroundJobStatus, setBackgroundJobStatus] = useState<BackgroundJobStatus | null>(null);
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (showBackgroundJobStatus && backgroundJobId) {
      pollBackgroundJobStatus();
    }

    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [showBackgroundJobStatus, backgroundJobId]);

  const pollBackgroundJobStatus = async () => {
    if (!backgroundJobId) return;

    try {
      const response = await fetch(`/api/ai/background-jobs/${backgroundJobId}/status/`);
      const status = await response.json();
      setBackgroundJobStatus(status);

      // Continue polling if job is still processing
      if (status.status === 'processing' || status.status === 'queued') {
        const interval = setInterval(async () => {
          try {
            const updatedResponse = await fetch(`/api/ai/background-jobs/${backgroundJobId}/status/`);
            const updatedStatus = await updatedResponse.json();
            setBackgroundJobStatus(updatedStatus);

            if (updatedStatus.status === 'completed' || updatedStatus.status === 'failed') {
              clearInterval(interval);
              setPollingInterval(null);
            }
          } catch (error) {
            console.error('Error polling background job status:', error);
          }
        }, 2000); // Poll every 2 seconds

        setPollingInterval(interval);
      }
    } catch (error) {
      console.error('Error fetching background job status:', error);
    }
  };

  const getAlertType = () => {
    if (error?.fallbackUsed) return 'warning';
    if (error?.backgroundJobId) return 'info';
    return 'error';
  };

  const getAlertMessage = () => {
    if (error?.backgroundJobId) {
      return `${error.service} is processing in the background`;
    }
    if (error?.fallbackUsed) {
      return `${error.service} used simplified processing`;
    }
    return `${error.service} is currently unavailable`;
  };

  const renderBackgroundJobStatus = () => {
    if (!backgroundJobStatus) return null;

    const getStatusColor = () => {
      switch (backgroundJobStatus.status) {
        case 'completed': return 'success';
        case 'failed': return 'exception';
        case 'processing': return 'active';
        default: return 'normal';
      }
    };

    return (
      <Card size="small" style={{ marginTop: 16 }}>
        <Title level={5}>
          <ClockCircleOutlined /> Background Processing Status
        </Title>

        <Progress
          percent={backgroundJobStatus.progress}
          status={getStatusColor()}
          showInfo={true}
        />

        <div style={{ marginTop: 8 }}>
          <Text strong>Status: </Text>
          <Text>{backgroundJobStatus.status}</Text>
        </div>

        {backgroundJobStatus.estimated_completion && (
          <div>
            <Text strong>Estimated completion: </Text>
            <Text>{backgroundJobStatus.estimated_completion}</Text>
          </div>
        )}

        {backgroundJobStatus.error_message && (
          <Alert
            message={backgroundJobStatus.error_message}
            type="error"
            size="small"
            style={{ marginTop: 8 }}
          />
        )}
      </Card>
    );
  };

  const renderManualOverrideOptions = () => {
    if (!error?.manualOverrideOptions?.available) return null;

    return (
      <Modal
        title={`Manual Override Options - ${error.service}`}
        open={showManualOptions}
        onCancel={() => setShowManualOptions(false)}
        footer={null}
        width={600}
      >
        <Paragraph>
          Choose a manual alternative to continue with your workflow:
        </Paragraph>

        <List
          dataSource={error.manualOverrideOptions.options}
          renderItem={(option) => (
            <List.Item
              actions={[
                <Button
                  type="primary"
                  onClick={() => {
                    onManualOverride?.(option);
                    setShowManualOptions(false);
                  }}
                >
                  Use This Option
                </Button>
              ]}
            >
              <List.Item.Meta
                title={option.display_name}
                description={
                  <div>
                    <Paragraph>{option.description}</Paragraph>
                    {option.tools_required.length > 0 && (
                      <div>
                        <Text strong>Tools required: </Text>
                        <Text code>{option.tools_required.join(', ')}</Text>
                      </div>
                    )}
                    {option.instructions && (
                      <div style={{ marginTop: 8 }}>
                        <Text strong>Instructions:</Text>
                        <ul>
                          {option.instructions.map((instruction, index) => (
                            <li key={index}>{instruction}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                }
              />
            </List.Item>
          )}
        />

        {error.manualOverrideOptions.tutorials.length > 0 && (
          <>
            <Divider />
            <Title level={5}>Helpful Tutorials</Title>
            <List
              size="small"
              dataSource={error.manualOverrideOptions.tutorials}
              renderItem={(tutorial) => (
                <List.Item
                  actions={[
                    <Button
                      type="link"
                      href={tutorial.url}
                      target="_blank"
                    >
                      Watch ({tutorial.duration})
                    </Button>
                  ]}
                >
                  {tutorial.title}
                </List.Item>
              )}
            />
          </>
        )}
      </Modal>
    );
  };

  if (!error) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      <Alert
        message={getAlertMessage()}
        description={
          <div>
            <Paragraph>{error.message}</Paragraph>

            {error.suggestedActions.length > 0 && (
              <div>
                <Text strong>Suggested actions:</Text>
                <ul>
                  {error.suggestedActions.map((action, index) => (
                    <li key={index}>{action}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        }
        type={getAlertType()}
        icon={<ExclamationCircleOutlined />}
        action={
          <div style={{ display: 'flex', gap: 8, flexDirection: 'column' }}>
            {onRetry && (
              <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
                Retry
              </Button>
            )}

            {error.manualOverrideAvailable && (
              <Button
                size="small"
                icon={<ToolOutlined />}
                onClick={() => setShowManualOptions(true)}
              >
                Manual Options
              </Button>
            )}

            {onDismiss && (
              <Button size="small" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
          </div>
        }
        closable={!!onDismiss}
        onClose={onDismiss}
      />

      {showBackgroundJobStatus && renderBackgroundJobStatus()}
      {renderManualOverrideOptions()}
    </div>
  );
};

export default AIFailureHandler;

// Hook for using AI failure handling
export const useAIFailureHandler = () => {
  const [error, setError] = useState<AIServiceError | null>(null);

  const handleAIError = (errorResponse: any, serviceName: string) => {
    const aiError: AIServiceError = {
      service: serviceName,
      message: errorResponse.detail || errorResponse.error || 'Service unavailable',
      fallbackUsed: errorResponse.fallback_used || false,
      manualOverrideAvailable: errorResponse.manual_override_available || false,
      suggestedActions: errorResponse.suggested_actions || [],
      manualOverrideOptions: errorResponse.manual_override_options,
      backgroundJobId: errorResponse.background_job_id
    };

    setError(aiError);
  };

  const clearError = () => setError(null);

  const retryOperation = async (operation: () => Promise<any>) => {
    try {
      clearError();
      return await operation();
    } catch (error: any) {
      if (error.response?.data) {
        handleAIError(error.response.data, 'AI Service');
      }
      throw error;
    }
  };

  return {
    error,
    handleAIError,
    clearError,
    retryOperation
  };
};

// Utility function to check AI service status
export const checkAIServiceStatus = async () => {
  try {
    const response = await fetch('/api/ai/status/');
    return await response.json();
  } catch (error) {
    console.error('Error checking AI service status:', error);
    return null;
  }
};

// Component for displaying overall AI service health
export const AIServiceHealthIndicator: React.FC = () => {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStatus = async () => {
      const serviceStatus = await checkAIServiceStatus();
      setStatus(serviceStatus);
      setLoading(false);
    };

    fetchStatus();

    // Refresh status every 30 seconds
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <Spin size="small" />;
  }

  if (!status) {
    return (
      <Alert
        message="Unable to check AI service status"
        type="warning"
        size="small"
      />
    );
  }

  const hasFailures = Object.values(status.failure_handling || {}).some(
    (service: any) => service.circuit_open
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: hasFailures ? '#ff4d4f' : '#52c41a'
        }}
      />
      <Text size="small">
        AI Services: {hasFailures ? 'Degraded' : 'Operational'}
      </Text>
    </div>
  );
};