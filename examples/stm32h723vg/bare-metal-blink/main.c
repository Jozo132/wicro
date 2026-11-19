typedef unsigned char uint8_t;
typedef unsigned short uint16_t;
typedef unsigned int uint32_t;

#define RCC_BASE 0x58024400U
#define RCC_AHB4ENR (*(volatile uint32_t *)(RCC_BASE + 0xe0U))
#define GPIOE_BASE 0x58021000U
#define GPIOE_MODER (*(volatile uint32_t *)(GPIOE_BASE + 0x00U))
#define GPIOE_BSRR (*(volatile uint32_t *)(GPIOE_BASE + 0x18U))

#define LED_PIN 3U

static void delay(volatile uint32_t count)
{
    while (count--) {
        __asm__ volatile ("nop");
    }
}

int main(void)
{
    RCC_AHB4ENR |= (1U << 4);
    GPIOE_MODER &= ~(3U << (LED_PIN * 2U));
    GPIOE_MODER |= (1U << (LED_PIN * 2U));

    for (;;) {
        GPIOE_BSRR = (1U << (LED_PIN + 16U));
        delay(400000U);
        GPIOE_BSRR = (1U << LED_PIN);
        delay(400000U);
    }
}

void _start(void)
{
    main();
}
