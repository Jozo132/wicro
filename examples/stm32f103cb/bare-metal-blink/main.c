typedef unsigned char uint8_t;
typedef unsigned short uint16_t;
typedef unsigned int uint32_t;

#define RCC_BASE 0x40021000U
#define RCC_APB2ENR (*(volatile uint32_t *)(RCC_BASE + 0x18U))
#define GPIOC_BASE 0x40011000U
#define GPIOC_CRH (*(volatile uint32_t *)(GPIOC_BASE + 0x04U))
#define GPIOC_ODR (*(volatile uint32_t *)(GPIOC_BASE + 0x0cU))

#define LED_PIN 13U

static void delay(volatile uint32_t count)
{
    while (count--) {
        __asm__ volatile ("nop");
    }
}

int main(void)
{
    RCC_APB2ENR |= (1U << 4);
    GPIOC_CRH &= ~(0xfU << ((LED_PIN - 8U) * 4U));
    GPIOC_CRH |= (1U << ((LED_PIN - 8U) * 4U));

    for (;;) {
        GPIOC_ODR &= ~(1U << LED_PIN);
        delay(400000U);
        GPIOC_ODR |= (1U << LED_PIN);
        delay(400000U);
    }
}

void _start(void)
{
    main();
}
